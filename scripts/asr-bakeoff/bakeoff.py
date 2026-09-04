#!/usr/bin/env python3
"""
Bake-off de ASR para dictado clínico en español.

    ./run.sh --grupo rapido            # 3 configs, arranque
    ./run.sh --grupo todo              # la matriz completa
    ./run.sh --config turbo turbo+hot  # solo el A/B del glosario

Lee audio de audio/ y referencias de refs/<mismo-nombre>.txt, corre cada config
sobre cada archivo, y escribe:

    results/raw.json      cada transcripción con su latencia (reanudable)
    results/report.md     el reporte que se lee
    results/diffs/        el texto de cada config por archivo, para ojear

Es reanudable: si lo matás a la mitad, la próxima corrida salta lo ya hecho.
Con --force vuelve a correr todo.

Lo que NO hace, a propósito: elegir por vos. El reporte muestra WER junto a
recall y alucinación de términos porque la decisión no es de un solo número.
Un modelo con mejor WER que inventa fármacos no sirve para una ficha clínica.
"""

from __future__ import annotations

import argparse
import json
import os
import statistics
import sys
import time
from collections import defaultdict

AQUI = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, AQUI)

import backends                                          # noqa: E402
import configs as cfgmod                                 # noqa: E402
from glosario import TERMINOS                            # noqa: E402
from metrics import (Comparacion, Conteo, MatcherTerminos, TerminosConteo,  # noqa: E402
                     comparar, contar_caracteres, contar_palabras, contar_terminos)

EXT_AUDIO = (".wav", ".flac", ".mp3", ".m4a", ".ogg", ".opus", ".webm", ".aac")


# ═══════════════════════════════════════════════════════════════════════════
# Corpus
# ═══════════════════════════════════════════════════════════════════════════

def descubrir(dir_audio: str, dir_refs: str) -> list[dict]:
    if not os.path.isdir(dir_audio):
        raise SystemExit(f"no existe {dir_audio} — leé el README, sección 1")

    audios = sorted(f for f in os.listdir(dir_audio) if f.lower().endswith(EXT_AUDIO))
    if not audios:
        raise SystemExit(
            f"{dir_audio} está vacío.\n"
            f"  1. Grabá los dictados (README §1)\n"
            f"  2. ./draft_refs.py   para el borrador de referencias\n"
            f"  3. corregí refs/*.draft.txt a mano y renombralos a .txt")

    items, sin_ref, borradores = [], [], []
    for a in audios:
        stem = os.path.splitext(a)[0]
        ref_path = os.path.join(dir_refs, stem + ".txt")
        draft_path = os.path.join(dir_refs, stem + ".draft.txt")
        if os.path.exists(ref_path):
            with open(ref_path, encoding="utf-8") as fh:
                ref = "\n".join(l for l in fh if not l.startswith("#")).strip()
            items.append({"id": stem, "audio": os.path.join(dir_audio, a), "ref": ref})
        else:
            sin_ref.append(stem)
            if os.path.exists(draft_path):
                borradores.append(stem)

    if borradores:
        print(f"\n  ⚠ {len(borradores)} borradores sin corregir "
              f"({', '.join(borradores[:5])}{'…' if len(borradores) > 5 else ''}).\n"
              f"    Un borrador NO es una referencia: si lo usaras como verdad, "
              f"medirías cuánto se parecen los modelos entre sí, no cuánto\n"
              f"    aciertan. Corregilos y renombralos .draft.txt → .txt.\n",
              file=sys.stderr)
    elif sin_ref:
        print(f"\n  ⚠ {len(sin_ref)} audios sin referencia, se ignoran: "
              f"{', '.join(sin_ref[:5])}{'…' if len(sin_ref) > 5 else ''}\n",
              file=sys.stderr)

    if not items:
        raise SystemExit("ningún audio tiene referencia. Ver README §2.")
    return items


# ═══════════════════════════════════════════════════════════════════════════
# Corrida
# ═══════════════════════════════════════════════════════════════════════════

def correr(items, lista_cfg, path_raw, force=False):
    crudo: dict[str, dict] = {}
    if os.path.exists(path_raw) and not force:
        with open(path_raw, encoding="utf-8") as fh:
            crudo = json.load(fh)

    activo, clave_activa = None, None

    for cfg in lista_cfg:
        pendientes = [it for it in items
                      if it["id"] not in crudo.get(cfg.id, {}).get("utts", {})]
        if not pendientes:
            print(f"[{cfg.id}] ya estaba completo, salto")
            continue

        if cfg.clave_modelo != clave_activa:
            if activo is not None:
                activo.liberar()
                activo = None
                _liberar_vram()
            print(f"[{cfg.id}] cargando {cfg.modelo} "
                  f"({cfg.device if cfg.backend == 'fw' else cfg.provider})…",
                  end="", flush=True)
            t0 = time.perf_counter()
            try:
                activo = backends.crear(cfg)
            except Exception as e:                        # noqa: BLE001
                print(f" FALLÓ\n    {type(e).__name__}: {e}\n"
                      f"    se salta esta config y sigue el resto", file=sys.stderr)
                clave_activa = None
                continue
            clave_activa = cfg.clave_modelo
            print(f" {time.perf_counter() - t0:.1f} s")

            # calentamiento: la primera inferencia paga compilación de kernels,
            # asignación de arenas y caché de disco. Medirla contaminaría la
            # config que caiga primero en el orden.
            try:
                activo.transcribir(backends.cargar_audio(pendientes[0]["audio"])[:SR_WARM], cfg)
            except Exception:                             # noqa: BLE001
                pass

        entrada = crudo.setdefault(cfg.id, {"descripcion": cfg.descripcion, "utts": {}})
        for i, it in enumerate(pendientes, 1):
            audio = backends.cargar_audio(it["audio"])
            dur = len(audio) / backends.SR
            t0 = time.perf_counter()
            try:
                txt = activo.transcribir(audio, cfg)
                err = None
            except Exception as e:                        # noqa: BLE001
                txt, err = "", f"{type(e).__name__}: {e}"
            dt = time.perf_counter() - t0
            entrada["utts"][it["id"]] = {
                "texto": txt, "latencia_s": round(dt, 3),
                "audio_s": round(dur, 2),
                "velocidad_x": round(dur / dt, 1) if dt > 0 else None,
                "error": err,
            }
            marca = "!" if err else "·"
            print(f"\r  [{cfg.id}] {i}/{len(pendientes)} {marca} "
                  f"{it['id'][:28]:<28} {dt:5.2f}s", end="", flush=True)
        print()

        with open(path_raw, "w", encoding="utf-8") as fh:   # guardado incremental
            json.dump(crudo, fh, ensure_ascii=False, indent=1)

    if activo is not None:
        activo.liberar()
        _liberar_vram()
    return crudo


SR_WARM = backends.SR * 3      # 3 s de audio alcanzan para calentar


def _liberar_vram():
    try:
        import gc

        import torch
        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:                                     # noqa: BLE001
        pass


# ═══════════════════════════════════════════════════════════════════════════
# Puntuación
# ═══════════════════════════════════════════════════════════════════════════

def puntuar(items, crudo, matcher):
    """Devuelve {config_id: {...agregados..., 'por_utt': {...}}}."""
    res = {}
    for cid, datos in crudo.items():
        utts = datos.get("utts", {})
        # w_str se guarda como dict por id, no como lista: si una corrida quedó
        # a medias, dos configs pueden cubrir distintos dictados y el bootstrap
        # pareado necesita alinearlos por id, no por posición.
        por_utt, w_str, w_rel, c_str = {}, {}, [], []
        terms = TerminosConteo()
        lat, vel, fallos = [], [], 0
        pal_ref = pal_hyp = vacias = 0

        for it in items:
            u = utts.get(it["id"])
            if u is None:
                continue
            if u.get("error"):
                fallos += 1
            hyp = u["texto"]
            if not hyp.strip():
                vacias += 1
            cs = contar_palabras(it["ref"], hyp, "strict")
            cr = contar_palabras(it["ref"], hyp, "relaxed")
            cc = contar_caracteres(it["ref"], hyp, "relaxed")
            ct = contar_terminos(it["ref"], hyp, matcher)
            w_str[it["id"]] = cs; w_rel.append(cr); c_str.append(cc)
            terms = terms + ct
            pal_ref += cs.n_ref
            pal_hyp += len(hyp.split())
            lat.append(u["latencia_s"])
            if u.get("velocidad_x"):
                vel.append(u["velocidad_x"])
            por_utt[it["id"]] = {
                "wer_strict": 100 * cs.tasa, "wer_relaxed": 100 * cr.tasa,
                "sust": cs.sust, "borr": cs.borr, "ins": cs.ins,
                "term_fn": ct.n_fn, "term_fp": ct.n_fp,
                "latencia_s": u["latencia_s"], "texto": hyp,
            }

        if not por_utt:
            continue
        tot_s = sum(w_str.values(), Conteo())
        tot_r = sum(w_rel, Conteo())
        tot_c = sum(c_str, Conteo())
        res[cid] = {
            "descripcion": datos.get("descripcion", ""),
            "wer_strict": 100 * tot_s.tasa,
            "wer_relaxed": 100 * tot_r.tasa,
            "cer": 100 * tot_c.tasa,
            "sust": tot_s.sust, "borr": tot_s.borr, "ins": tot_s.ins,
            "term_recall": 100 * terms.recall,
            "term_halluc": terms.n_fp,
            "term_perdidos": terms.n_fn,
            "terminos": terms,
            "lat_mediana": statistics.median(lat),
            "lat_p90": sorted(lat)[max(0, int(0.9 * len(lat)) - 1)],
            "velocidad_x": statistics.median(vel) if vel else None,
            "fallos": fallos,
            "vacias": vacias,
            # cociente palabras transcritas / palabras de referencia. Detecta
            # los dos modos de falla que el WER solo no distingue: la salida
            # colapsada (el modelo se corta y devuelve una frase) y el bucle de
            # repetición (devuelve tres veces lo mismo).
            "ratio_palabras": (pal_hyp / pal_ref) if pal_ref else float("nan"),
            "conteos_strict": w_str,
            "por_utt": por_utt,
        }
    return res


# ═══════════════════════════════════════════════════════════════════════════
# Reporte
# ═══════════════════════════════════════════════════════════════════════════

def _comparar_alineado(ra, rb):
    """
    Bootstrap pareado entre dos configs, sobre los dictados que AMBAS cubren.
    Devuelve None si no comparten ninguno (corrida interrumpida, config que
    falló a mitad de camino).
    """
    comunes = sorted(set(ra["conteos_strict"]) & set(rb["conteos_strict"]))
    if not comunes:
        return None
    return comparar([ra["conteos_strict"][k] for k in comunes],
                    [rb["conteos_strict"][k] for k in comunes])


def reporte(items, res, base_id, out_md):
    L: list[str] = []
    A = L.append

    n = len(items)

    A("# Bake-off de ASR — dictado clínico en español\n")
    A(f"**Corpus:** {n} dictados · "
      f"{sum(len(i['ref'].split()) for i in items)} palabras de referencia\n")
    A("Todo se normaliza igual en ref e hipótesis (ver `normalize.py`). "
      "`strict` conserva tildes; `relaxed` las pliega y unifica unidades, "
      "romanos y decimales. **La distancia entre las dos columnas te dice "
      "cuánto de tu error es cosmético** y lo arregla el post-proceso.\n")

    # ── 1. ranking ───────────────────────────────────────────────────────────
    A("## 1. Ranking\n")
    A("| Config | WER strict | WER relaxed | CER | Recall términos | "
      "Alucinados | Vacías | Palabras | Lat. mediana | ×tiempo real |")
    A("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|")
    for cid, r in sorted(res.items(), key=lambda kv: kv[1]["wer_relaxed"]):
        marca = " ⭐" if cid == base_id else ""
        vel = f"{r['velocidad_x']:.0f}×" if r["velocidad_x"] else "—"
        halluc = (f"**{r['term_halluc']}**" if r["term_halluc"] else "0")
        vac = (f"**{r['vacias']}/{n}** 🚨" if r["vacias"] else "0")
        p = r["ratio_palabras"]
        pal = f"{p:.0%}" if 0.7 <= p <= 1.4 else f"**{p:.0%}** 🚨"
        A(f"| `{cid}`{marca} | {r['wer_strict']:.2f}% | {r['wer_relaxed']:.2f}% | "
          f"{r['cer']:.2f}% | {r['term_recall']:.1f}% | {halluc} | {vac} | {pal} | "
          f"{r['lat_mediana']:.2f} s | {vel} |")
    A("")
    A("**Vacías** = dictados que volvieron sin una sola palabra. Canary hace "
      "esto cuando el audio no coincide con su `src_lang` — verificado. En un "
      "dictado con code-switching (peeling, láser, shaving, punch) puede "
      "significar perder la nota entera, no degradarla.\n")
    A("**Palabras** = transcritas / dichas. Cerca de 100% es sano; muy por "
      "debajo, la config se cortó; muy por encima, entró en bucle de "
      "repetición. Un WER alto no distingue esos casos y se arreglan distinto.\n")
    A("**Alucinados** = términos del glosario que el modelo escribió y nadie "
      "dijo. Es la columna que puede descalificar al ganador del WER: en una "
      "ficha clínica, un fármaco inventado es peor que diez tildes.\n")

    fallidas = [f"`{c}` ({r['fallos']})" for c, r in res.items() if r["fallos"]]
    if fallidas:
        A("> ⚠ Configs con errores de inferencia (entre paréntesis, cuántos "
          "dictados fallaron): " + ", ".join(fallidas) + "\n")

    # Salida colapsada / bucle de repetición: un WER alto no distingue "entendió
    # mal" de "devolvió una frase y se cortó", y el arreglo es completamente
    # distinto. El cociente de palabras sí los distingue.
    cortas = [(c, r["ratio_palabras"]) for c, r in res.items()
              if r["ratio_palabras"] < 0.7]
    largas = [(c, r["ratio_palabras"]) for c, r in res.items()
              if r["ratio_palabras"] > 1.4]
    if cortas:
        A("> 🚨 **Salida colapsada** — estas configs transcribieron mucho menos "
          "de lo que se dijo: " +
          ", ".join(f"`{c}` ({p:.0%} de las palabras)" for c, p in cortas) +
          ".\n> No es que entiendan mal: se cortan. Mirá `results/diffs/` antes "
          "de sacar cualquier conclusión de su WER. Si la config lleva "
          "`initial_prompt`, la causa más probable es que el modelo completó el "
          "prompt y emitió fin-de-texto.\n")
    if largas:
        A("> 🚨 **Bucle de repetición** — estas devolvieron mucho más texto del "
          "que se dijo: " +
          ", ".join(f"`{c}` ({p:.0%})" for c, p in largas) +
          ".\n> Es el modo de falla clásico de Whisper. Revisá que "
          "`condition_on_previous_text=False` y que el VAD esté activo.\n")

    # ── 2. comparaciones ─────────────────────────────────────────────────────
    if base_id not in res:
        A(f"## 2. Comparaciones\n")
        A(f"_Sin baseline: `{base_id}` no está entre las configs corridas, así "
          f"que no hay contra qué comparar y este reporte es solo un ranking._ "
          f"Agregá `{base_id}` a la corrida o pasá `--baseline <otra>`.\n")
    else:
        A(f"## 2. ¿Las diferencias son reales? (bootstrap pareado vs `{base_id}`)\n")
        A("Con 10-30 dictados, medio punto de WER es ruido. El intervalo es de "
          "95%; si cruza el cero, la diferencia no está demostrada **y el "
          "reporte te dice cuántas muestras harían falta**.\n")
        A("| Config | ΔWER vs baseline | Veredicto |")
        A("|---|---:|---|")
        for cid, r in sorted(res.items(), key=lambda kv: kv[1]["wer_relaxed"]):
            if cid == base_id:
                continue
            c = _comparar_alineado(res[base_id], r)
            if c is None:
                A(f"| `{cid}` | — | sin dictados en común con el baseline |")
                continue
            A(f"| `{cid}` | {c.delta:+.2f} pp [{c.lo:+.2f}, {c.hi:+.2f}] | "
              f"{'concluyente' if c.concluyente else f'ruido (~{c.n_necesario} muestras)'} |")
        A("")

    # ── 3. hotwords ──────────────────────────────────────────────────────────
    pares = [(a, b) for a in res for b in res if b == a + "+hot"]
    if pares:
        A("## 3. El veredicto sobre el glosario (`hotwords`)\n")
        A("La pregunta no es \"¿baja el WER?\" sino \"¿baja el WER **sin** "
          "inventar términos?\". Un glosario que sube `alucinados` se descarta "
          "aunque gane en WER.\n")
        for a, b in pares:
            ra, rb = res[a], res[b]
            c = _comparar_alineado(ra, rb)
            A(f"### `{a}` → `{b}`\n")
            A(f"- **WER:** {c.veredicto(a, b) if c else 'sin dictados en común'}")
            A(f"- **Recall de términos:** {ra['term_recall']:.1f}% → "
              f"{rb['term_recall']:.1f}% "
              f"({rb['term_recall'] - ra['term_recall']:+.1f} pp)")
            A(f"- **Alucinados:** {ra['term_halluc']} → {rb['term_halluc']} "
              f"({rb['term_halluc'] - ra['term_halluc']:+d})")
            if rb["term_halluc"] > ra["term_halluc"]:
                A(f"- ⚠ **El glosario inventó "
                  f"{rb['term_halluc'] - ra['term_halluc']} términos de más.** "
                  f"Mirá cuáles en §4 y sacalos de `glosario.py` antes de "
                  f"volver a medir.")
            A("")

    # ── 4. términos ──────────────────────────────────────────────────────────
    A("## 4. Términos, uno por uno\n")
    A("Solo los que aparecen en las referencias o que algún modelo inventó. "
      "Si un término está en el glosario y no aparece acá, tus dictados no lo "
      "ejercitan: no sabés nada sobre él.\n")
    interesantes = set()
    for r in res.values():
        t: TerminosConteo = r["terminos"]
        interesantes |= set(t.tp) | set(t.fn) | set(t.fp)
    if interesantes:
        cids = list(res)
        A("| Término | " + " | ".join(f"`{c}`" for c in cids) + " |")
        A("|---|" + "---:|" * len(cids))
        for term in sorted(interesantes):
            fila = []
            for c in cids:
                t = res[c]["terminos"]
                ok, fn, fp = t.tp.get(term, 0), t.fn.get(term, 0), t.fp.get(term, 0)
                celda = f"{ok}✓"
                if fn:
                    celda += f" {fn}✗"
                if fp:
                    celda += f" **{fp}👻**"
                fila.append(celda)
            A(f"| {term} | " + " | ".join(fila) + " |")
        A("")
        A("`✓` acertado · `✗` dicho y perdido · `👻` **inventado**\n")
    else:
        A("_Ningún término del glosario aparece en las referencias._ "
          "**Eso invalida toda la evaluación de `hotwords`**: si tus dictados "
          "no contienen vocabulario dermatológico, no podés medir si el "
          "glosario ayuda. Grabá casos con diagnósticos y fármacos reales.\n")

    # ── 5. peores ────────────────────────────────────────────────────────────
    A("## 5. Los peores dictados\n")
    A("Antes de creerle al ranking, leé estos. La mitad de las veces el "
      "problema es la grabación (micrófono lejos, ventilador, dos voces) o la "
      "referencia mal tipeada, no el modelo.\n")
    for cid, r in sorted(res.items(), key=lambda kv: kv[1]["wer_relaxed"])[:3]:
        peores = sorted(r["por_utt"].items(),
                        key=lambda kv: -kv[1]["wer_relaxed"])[:3]
        A(f"**`{cid}`**\n")
        for uid, u in peores:
            A(f"- `{uid}` — WER {u['wer_relaxed']:.1f}% "
              f"(S{u['sust']} B{u['borr']} I{u['ins']})")
        A("")

    # ── 6. latencia ──────────────────────────────────────────────────────────
    A("## 6. Latencia\n")
    A("Sin el tiempo de decodificar el audio (se decodifica una vez y se "
      "comparte) y sin la primera inferencia de cada modelo, que se descarta "
      "como calentamiento. Es inferencia pura: sumale subida del archivo y "
      "red para la latencia que siente el médico.\n")
    A("| Config | mediana | p90 | ×tiempo real |")
    A("|---|---:|---:|---:|")
    for cid, r in sorted(res.items(), key=lambda kv: kv[1]["lat_mediana"]):
        vel = f"{r['velocidad_x']:.0f}×" if r["velocidad_x"] else "—"
        A(f"| `{cid}` | {r['lat_mediana']:.2f} s | {r['lat_p90']:.2f} s | {vel} |")
    A("")

    # ── 7. qué mirar ─────────────────────────────────────────────────────────
    A("## 7. Cómo decidir con esto\n")
    A("1. Descartá toda config con `alucinados` alto, sin importar su WER.\n"
      "2. Entre las que quedan, mirá el §2: si la diferencia con el baseline "
      "no es concluyente, quedate con la **más barata de operar**, no con la "
      "de mejor número.\n"
      "3. Recién ahí mirá latencia. Por debajo de ~5 s el médico no nota la "
      "diferencia; el salto que importa es el de 5 s a 30 s.\n"
      "4. Chequeá la licencia: `parakeet` y `canary` son CC-BY-4.0 y exigen "
      "atribución visible a NVIDIA en el producto.\n")

    with open(out_md, "w", encoding="utf-8") as fh:
        fh.write("\n".join(L))
    return "\n".join(L)


def volcar_diffs(items, crudo, dir_diffs):
    os.makedirs(dir_diffs, exist_ok=True)
    refs = {i["id"]: i["ref"] for i in items}
    for uid, ref in refs.items():
        L = [f"### REFERENCIA — {uid}", ref, ""]
        for cid, datos in crudo.items():
            u = datos.get("utts", {}).get(uid)
            if u:
                L += [f"### {cid}  ({u['latencia_s']:.2f} s)",
                      u.get("error") or u["texto"], ""]
        with open(os.path.join(dir_diffs, uid + ".txt"), "w", encoding="utf-8") as fh:
            fh.write("\n".join(L))


# ═══════════════════════════════════════════════════════════════════════════

def main():
    p = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--config", nargs="+", default=None,
                   help="ids de config y/o grupos (default: grupo 'rapido')")
    p.add_argument("--grupo", default=None, help="atajo de --config con un grupo")
    p.add_argument("--audio-dir", default=os.path.join(AQUI, "audio"))
    p.add_argument("--refs-dir", default=os.path.join(AQUI, "refs"))
    p.add_argument("--out", default=os.path.join(AQUI, "results"))
    p.add_argument("--force", action="store_true", help="reejecuta todo")
    p.add_argument("--solo-reporte", action="store_true",
                   help="rehace el reporte desde raw.json, sin transcribir")
    p.add_argument("--baseline", default=cfgmod.BASELINE)
    p.add_argument("--listar", action="store_true")
    a = p.parse_args()

    if a.listar:
        print("configs:")
        for c in cfgmod.CONFIGS:
            print(f"  {c.id:<14} {c.descripcion}")
        print("\ngrupos:")
        for g, ids in cfgmod.GRUPOS.items():
            print(f"  {g:<14} {', '.join(ids)}")
        return

    # --grupo y --config se suman; pasar los dos no descarta uno en silencio
    nombres = ([a.grupo] if a.grupo else []) + (a.config or [])
    lista = cfgmod.resolver(nombres or ["rapido"])

    os.makedirs(a.out, exist_ok=True)
    path_raw = os.path.join(a.out, "raw.json")
    items = descubrir(a.audio_dir, a.refs_dir)
    print(f"corpus: {len(items)} dictados con referencia\n")

    if a.solo_reporte:
        if not os.path.exists(path_raw):
            raise SystemExit("no hay results/raw.json todavía")
        with open(path_raw, encoding="utf-8") as fh:
            crudo = json.load(fh)
    else:
        crudo = correr(items, lista, path_raw, a.force)

    matcher = MatcherTerminos(TERMINOS)
    res = puntuar(items, crudo, matcher)
    if not res:
        raise SystemExit("no hay resultados que puntuar")

    out_md = os.path.join(a.out, "report.md")
    texto = reporte(items, res, a.baseline, out_md)
    volcar_diffs(items, crudo, os.path.join(a.out, "diffs"))

    print(texto.split("## 2.")[0])
    print(f"\n→ {out_md}")
    print(f"→ {os.path.join(a.out, 'diffs')}/  (una transcripción por dictado)")


if __name__ == "__main__":
    main()
