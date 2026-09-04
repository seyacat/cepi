"""
Glosario dermatológico para `hotwords` y para medir cobertura de términos.

Fuente: docs/ASR_PLAN_LOCAL.md §5.2. Si lo cambiás acá, cambialo allá — cuando
`cepi-isic/asr.py` exista, este archivo debería ser el único origen y asr.py
importarlo.

Dos restricciones duras, ambas del código de faster-whisper:

1. El prompt tiene un techo de **223 tokens** (`max_length // 2 - 1`), y
   faster-whisper **trunca en silencio** al pasarse:

       if len(hotwords_tokens) >= max_length // 2:
           hotwords_tokens = hotwords_tokens[: max_length // 2 - 1]

   Sin excepción, sin warning. En español médico el tokenizer parte mucho
   ("carcinoma espinocelular" = 12 tokens), así que entran ~35 términos, no
   más. La versión de este glosario que aparece en `ASR_PLAN_LOCAL.md` §5.2
   daba **226 tokens**: se comía los últimos 3 sin avisar.

2. Los términos más raros van **AL FINAL**: la atención pesa más lo último.
   Lo que hace peor al truncado silencioso — corta exactamente los términos
   que más te importaban. Corré `python glosario.py` cada vez que lo toques.

Y el riesgo que el bake-off existe para medir: el sesgo por contexto baja el WER
en vocabulario de dominio pero **sube las inserciones alucinadas**. Una
"queratosis actínica" que nadie dijo, en una ficha clínica, es peligrosa. Por eso
`bakeoff.py` reporta `term_halluc` aparte del WER global: un glosario puede
mejorar el WER y aun así ser inaceptable.
"""

from __future__ import annotations

# ── El glosario que se pasa como `hotwords` (orden: raro al final) ────────────
TERMINOS: list[str] = [
    # técnica y descripción
    # (la variante "dermatoscopía" se sacó por presupuesto de tokens: son 8 y
    #  el glosario completo daba 226/223. Ver la nota de arriba.)
    "dermatoscopia",
    "fototipo Fitzpatrick",
    # "biopsia incisional" también salió (10 tokens): "biopsia" es palabra de
    # alta frecuencia en cualquier corpus, Whisper la acierta sin ayuda. El
    # glosario es para lo RARO — gastar presupuesto en lo común lo desperdicia.
    "criocirugía",
    # lesiones pigmentadas
    "nevo melanocítico",
    "nevus displásico",
    "léntigo solar",
    "queratosis actínica",
    "queratosis seborreica",
    # tumores
    "carcinoma basocelular",
    "carcinoma espinocelular",
    "melanoma de extensión superficial",
    "índice de Breslow",
    # inflamatorias
    "psoriasis en placas",
    "dermatitis atópica",
    "dermatitis de contacto",
    "rosácea",
    "hidradenitis supurativa",
    "acné noduloquístico",
    "vitíligo",
    # infecciosas / tropicales (Ecuador)
    "onicomicosis",
    "pitiriasis versicolor",
    "escabiosis",
    "larva migrans",
    "leishmaniasis cutánea",
    "esporotricosis",
    # fármacos — lo más raro, al final
    "clobetasol",
    "tacrolimus",
    "mupirocina",
    "imiquimod",
    "isotretinoína",
    "metotrexato",
    "hidroxicloroquina",
    "dupilumab",
]

# faster-whisper quiere un string; lista separada por comas y NUNCA una frase
# narrativa (el modelo continúa el estilo de lo que le des).
GLOSARIO = ", ".join(TERMINOS)

# sherpa-onnx quiere una frase por línea.
GLOSARIO_SHERPA = "\n".join(TERMINOS)

# initial_prompt: fija estilo, NADA de vocabulario. Ver ASR_PLAN_LOCAL.md §5.3 —
# con condition_on_previous_text=False el initial_prompt solo sesga los primeros
# 30 s, así que meter el glosario acá lo aplicaría al 17% de un dictado de 180 s.
PROMPT_ESTILO = "Dictado clínico en español. Puntuación y mayúsculas normales."


def contar_tokens(modelo: str = "openai/whisper-large-v3-turbo") -> int:
    """Tokens reales del glosario según el tokenizer de Whisper. Techo: 223."""
    import tokenizers

    tk = tokenizers.Tokenizer.from_pretrained(modelo)
    return len(tk.encode(" " + GLOSARIO).ids)


if __name__ == "__main__":
    import sys

    n = contar_tokens()
    print(f"{len(TERMINOS)} términos, {n} tokens (techo 223)")
    if n > 223:
        sobra = n - 223
        print(f"\n  ✗ SE PASA por {sobra} tokens. faster-whisper los corta sin\n"
              f"    avisar, y corta el FINAL: perderías los términos más raros,\n"
              f"    que son los que justifican tener glosario.\n"
              f"    Sacá términos del medio de la lista, no del final.", file=sys.stderr)
        sys.exit(1)
    print(f"  ✓ entra, con {223 - n} tokens de margen")
