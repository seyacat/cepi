"""
Métricas del bake-off.

Tres bloques, en orden de importancia clínica descendente:

1. **Términos** (`term_recall`, `term_halluc`). Lo que de verdad decide.
   Un modelo con 6% de WER que no falla nunca un fármaco es mejor para una
   ficha que uno con 4% que a veces escribe "tacrolimus" donde dijiste
   "clobetasol". Y `term_halluc` mide el daño del glosario: términos que el
   modelo escupió y NADIE dijo.

2. **WER / CER**. El número comparable con el mundo exterior.
   Se agrega a nivel corpus (suma de errores / suma de palabras de referencia),
   NO como promedio de WER por archivo — promediar tasas le da el mismo peso a
   un dictado de 8 palabras que a uno de 400, y con N=20 eso mueve el ranking.

3. **Bootstrap pareado**. Con 10-30 muestras, una diferencia de 0.5 puntos de
   WER es ruido. `comparar()` devuelve el intervalo de confianza de la
   diferencia y, si no es concluyente, cuántas muestras harían falta.
"""

from __future__ import annotations

import random
import re
from dataclasses import dataclass, field

import jiwer

from normalize import normalizar, plegar


# ═══════════════════════════════════════════════════════════════════════════
# WER / CER
# ═══════════════════════════════════════════════════════════════════════════

@dataclass
class Conteo:
    """Errores crudos de un archivo. Se suman a nivel corpus, no se promedian."""
    sust: int = 0
    borr: int = 0
    ins: int = 0
    n_ref: int = 0

    @property
    def errores(self) -> int:
        return self.sust + self.borr + self.ins

    def __add__(self, otro: "Conteo") -> "Conteo":
        return Conteo(
            self.sust + otro.sust, self.borr + otro.borr,
            self.ins + otro.ins, self.n_ref + otro.n_ref,
        )

    @property
    def tasa(self) -> float:
        return self.errores / self.n_ref if self.n_ref else 0.0


def contar_palabras(ref: str, hyp: str, perfil: str) -> Conteo:
    r, h = normalizar(ref, perfil), normalizar(hyp, perfil)
    if not r:
        # referencia vacía: todo lo que salga es inserción, pero sin denominador
        return Conteo(ins=len(h.split()), n_ref=0)
    o = jiwer.process_words(r, h)
    return Conteo(o.substitutions, o.deletions, o.insertions, len(r.split()))


def contar_caracteres(ref: str, hyp: str, perfil: str) -> Conteo:
    r, h = normalizar(ref, perfil), normalizar(hyp, perfil)
    if not r:
        return Conteo(ins=len(h), n_ref=0)
    o = jiwer.process_characters(r, h)
    return Conteo(o.substitutions, o.deletions, o.insertions, len(r))


# ═══════════════════════════════════════════════════════════════════════════
# Términos del glosario
# ═══════════════════════════════════════════════════════════════════════════

def _regex_termino(termino: str) -> re.Pattern:
    """
    Matcher tolerante a flexión: plegado de acentos + plural opcional en la
    última palabra. "queratosis actínica" matchea "queratosis actinicas".
    """
    palabras = [re.escape(p) for p in plegar(termino).split()]
    if not palabras:
        return re.compile(r"(?!)")
    cuerpo = r"\s+".join(palabras[:-1] + [palabras[-1] + r"(?:e?s)?"])
    return re.compile(r"(?<![a-z0-9ñ])" + cuerpo + r"(?![a-z0-9ñ])")


class MatcherTerminos:
    def __init__(self, terminos: list[str]):
        # "dermatoscopia"/"dermatoscopía" colapsan al plegar acentos: se
        # deduplican solas, que es exactamente lo que queremos para contar.
        vistos: dict[str, str] = {}
        for t in terminos:
            vistos.setdefault(plegar(t), t)
        self.canonicos = list(vistos.values())
        self.regex = {t: _regex_termino(t) for t in self.canonicos}

    def contar(self, texto: str) -> dict[str, int]:
        plano = plegar(normalizar(texto, "relaxed"))
        return {t: len(rx.findall(plano)) for t, rx in self.regex.items()}


@dataclass
class TerminosConteo:
    """TP / FN / FP por término, sumables a nivel corpus."""
    tp: dict[str, int] = field(default_factory=dict)   # dicho y transcrito
    fn: dict[str, int] = field(default_factory=dict)   # dicho y perdido
    fp: dict[str, int] = field(default_factory=dict)   # transcrito y NO dicho

    def __add__(self, otro: "TerminosConteo") -> "TerminosConteo":
        def mezcla(a, b):
            out = dict(a)
            for k, v in b.items():
                out[k] = out.get(k, 0) + v
            return out
        return TerminosConteo(
            mezcla(self.tp, otro.tp), mezcla(self.fn, otro.fn),
            mezcla(self.fp, otro.fp),
        )

    @property
    def n_tp(self) -> int: return sum(self.tp.values())
    @property
    def n_fn(self) -> int: return sum(self.fn.values())
    @property
    def n_fp(self) -> int: return sum(self.fp.values())

    @property
    def recall(self) -> float:
        d = self.n_tp + self.n_fn
        return self.n_tp / d if d else float("nan")

    @property
    def precision(self) -> float:
        d = self.n_tp + self.n_fp
        return self.n_tp / d if d else float("nan")


def contar_terminos(ref: str, hyp: str, matcher: MatcherTerminos) -> TerminosConteo:
    cr, ch = matcher.contar(ref), matcher.contar(hyp)
    c = TerminosConteo()
    for t in matcher.canonicos:
        r, h = cr[t], ch[t]
        if min(r, h):
            c.tp[t] = min(r, h)
        if r > h:
            c.fn[t] = r - h
        if h > r:
            c.fp[t] = h - r
    return c


# ═══════════════════════════════════════════════════════════════════════════
# Bootstrap pareado
# ═══════════════════════════════════════════════════════════════════════════

@dataclass
class Comparacion:
    delta: float            # WER(b) - WER(a), en puntos porcentuales
    lo: float               # IC 95% inferior
    hi: float               # IC 95% superior
    p_b_mejor: float        # P(WER(b) < WER(a)) sobre los remuestreos
    n: int
    n_necesario: int | None  # muestras para que el IC excluya el 0, si aplica

    @property
    def concluyente(self) -> bool:
        return (self.lo > 0) or (self.hi < 0)

    def veredicto(self, nombre_a: str, nombre_b: str) -> str:
        signo = "+" if self.delta >= 0 else ""
        base = (f"Δ {signo}{self.delta:.2f} pp "
                f"[{self.lo:+.2f}, {self.hi:+.2f}] (n={self.n})")
        if not self.concluyente:
            extra = f", harían falta ~{self.n_necesario}" if self.n_necesario else ""
            return f"{base} → NO CONCLUYENTE{extra}"
        mejor = nombre_b if self.delta < 0 else nombre_a
        return f"{base} → gana **{mejor}**"


def comparar(a: list[Conteo], b: list[Conteo],
             n_boot: int = 10_000, seed: int = 20260728) -> Comparacion:
    """
    Bootstrap pareado sobre archivos. `a` y `b` son los conteos por archivo de
    dos configs, en el MISMO orden (mismo corpus). Devuelve WER(b)-WER(a) en
    puntos porcentuales.

    Pareado = se remuestrean los mismos índices para ambas configs. Eso cancela
    la varianza "este dictado es difícil" y deja solo la diferencia entre
    configs, que es lo único que querés medir. Sin parear, con N=20 casi nada
    da significativo.
    """
    assert len(a) == len(b), "corpus distintos, no se pueden parear"
    n = len(a)
    rnd = random.Random(seed)

    def wer(sel, cs):
        e = sum(cs[i].errores for i in sel)
        d = sum(cs[i].n_ref for i in sel)
        return 100.0 * e / d if d else 0.0

    todos = list(range(n))
    real = wer(todos, b) - wer(todos, a)

    deltas = []
    for _ in range(n_boot):
        sel = [rnd.randrange(n) for _ in range(n)]
        deltas.append(wer(sel, b) - wer(sel, a))
    deltas.sort()
    lo = deltas[int(0.025 * n_boot)]
    hi = deltas[int(0.975 * n_boot)]
    p = sum(1 for d in deltas if d < 0) / n_boot

    # Cuántas muestras harían falta: el ancho del IC cae con 1/sqrt(N), así que
    # N_req ≈ N · (semiancho / |delta|)². Es una estimación gruesa — sirve para
    # saber si te faltan 5 dictados o 500.
    n_req = None
    if not (lo > 0 or hi < 0) and abs(real) > 1e-9:
        semi = (hi - lo) / 2
        n_req = min(10_000, max(n + 1, int(n * (semi / abs(real)) ** 2) + 1))

    return Comparacion(real, lo, hi, p, n, n_req)
