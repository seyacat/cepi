"""
Normalización de texto en español para medir WER de dictado clínico.

Por qué esto importa más que el modelo que elijas: sin normalizar, "3 mm" vs
"tres milímetros" cuenta como 2 errores sobre 2 palabras = 100% WER en ese
tramo, y el ranking de modelos termina midiendo estilo de formateo en vez de
reconocimiento. Con normalización agresiva pasa lo contrario: escondés errores
reales bajo la alfombra.

Por eso hay DOS perfiles y el reporte muestra los dos:

  strict   NFC + minúsculas + números a palabras + sin puntuación.
           Los acentos CUENTAN. Es el número que le mostrás a un tercero.

  relaxed  strict + acentos plegados + unidades/abreviaturas equivalentes +
           romanos I-VI (Fitzpatrick) + punto/coma decimal indistintos.
           Es el número que se acerca a "¿el LLM va a entender esto?".

La distancia entre ambos es informativa: si strict=9% y relaxed=4%, los errores
son cosméticos (tildes, unidades) y los arregla el post-proceso. Si son iguales,
los errores son de verdad.

TODO transforma ref e hyp con la MISMA función. Cualquier equivalencia que
agregues acá es simétrica: puede ocultar un error real, nunca inventarlo.
"""

from __future__ import annotations

import re
import unicodedata

from num2words import num2words

# ── unidades: se expanden a palabra para que "5mg" == "cinco miligramos" ──────
# Solo las que de verdad aparecen dictadas en dermatología. Cada entrada que
# agregues es una equivalencia que dejás de poder medir.
_UNIDADES = [
    (r"(?<=[\d\s])mg\b", " miligramos"),
    (r"(?<=[\d\s])ml\b", " mililitros"),
    (r"(?<=[\d\s])cm\b", " centímetros"),
    (r"(?<=[\d\s])mm\b", " milímetros"),
    (r"(?<=[\d\s])kg\b", " kilogramos"),
    (r"(?<=[\d\s])(?:mcg|µg|ug)\b", " microgramos"),
    (r"%", " por ciento "),
    (r"\bnº\b|\bn°\b|\bnro\b", " número "),
    (r"\bdr\b\.?", " doctor "),
    (r"\bdra\b\.?", " doctora "),
    (r"\bpte\b\.?", " paciente "),
]

# ── romanos I-VI: el fototipo Fitzpatrick se dicta "tres" y se escribe "III" ──
_ROMANOS = {
    "i": "uno", "ii": "dos", "iii": "tres",
    "iv": "cuatro", "v": "cinco", "vi": "seis",
}

# ── singular→plural de unidades, solo en relaxed ─────────────────────────────
_SINGULARES = {
    "miligramo": "miligramos", "mililitro": "mililitros",
    "centímetro": "centímetros", "milímetro": "milímetros",
    "centimetro": "centimetros", "milimetro": "milimetros",
    "kilogramo": "kilogramos", "microgramo": "microgramos",
    "un": "uno", "una": "uno",
}

_NUM_RE = re.compile(r"\d+(?:[.,]\d+)?")
_PUNCT_RE = re.compile(r"[^\w\s]|_", re.UNICODE)
_WS_RE = re.compile(r"\s+")


def _num_a_palabras(m: re.Match) -> str:
    tok = m.group(0)
    if "," in tok or "." in tok:
        sep = "," if "," in tok else "."
        ent, dec = tok.split(sep, 1)
        izq = num2words(int(ent), lang="es") if ent else "cero"
        der = " ".join(num2words(int(d), lang="es") for d in dec)
        return f" {izq} coma {der} "
    n = int(tok)
    # num2words revienta con enteros absurdos; un número de 15 cifras en un
    # dictado clínico es basura de todos modos, lo dejamos dígito a dígito.
    if n > 10**12:
        return " " + " ".join(num2words(int(d), lang="es") for d in tok) + " "
    return f" {num2words(n, lang='es')} "


def _plegar_acentos(s: str) -> str:
    nfd = unicodedata.normalize("NFD", s)
    # se conserva la ñ: en español distingue palabras (año/ano), no es un acento
    sin = "".join(c for c in nfd if unicodedata.category(c) != "Mn" or c == "̃")
    return unicodedata.normalize("NFC", sin)


def normalizar(texto: str, perfil: str = "strict") -> str:
    """Devuelve el texto listo para comparar palabra a palabra."""
    if not texto:
        return ""

    s = unicodedata.normalize("NFC", texto).lower()

    # guiones y barras separan palabras, no las unen
    s = re.sub(r"[-–—/]", " ", s)

    for patron, reemplazo in _UNIDADES:
        s = re.sub(patron, reemplazo, s)

    s = _NUM_RE.sub(_num_a_palabras, s)
    s = _PUNCT_RE.sub(" ", s)
    palabras = _WS_RE.sub(" ", s).strip().split()

    if perfil == "strict":
        return " ".join(palabras)

    if perfil != "relaxed":
        raise ValueError(f"perfil desconocido: {perfil!r} (usa strict|relaxed)")

    out = []
    for w in palabras:
        w = _ROMANOS.get(w, w)
        w = _SINGULARES.get(w, w)
        if w == "punto":          # separador decimal dictado
            w = "coma"
        out.append(_plegar_acentos(w))
    return " ".join(out)


def plegar(texto: str) -> str:
    """Minúsculas sin acentos. Para hacer matching de términos del glosario."""
    return _plegar_acentos(unicodedata.normalize("NFC", texto).lower())


if __name__ == "__main__":
    pruebas = [
        "Lesión de 3,5 mm en dorso. Fototipo III. Clobetasol 0.05% BID.",
        "lesion de tres coma cinco milimetros en dorso fototipo tres "
        "clobetasol cero coma cero cinco por ciento bid",
    ]
    for p in pruebas:
        print("  in :", p)
        print("  str:", normalizar(p, "strict"))
        print("  rel:", normalizar(p, "relaxed"))
        print()
