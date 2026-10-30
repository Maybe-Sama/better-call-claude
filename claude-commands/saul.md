---
description: AgentCall - llamadas de voz en esta sesion (on | off; sin argumento, estado)
argument-hint: on | off
disable-model-invocation: true
---
El usuario ha escrito "/saul $ARGUMENTS" para activar o desactivar las llamadas de voz de AgentCall en esta sesión de Claude Code.

AgentCall procesa este comando por su cuenta y, si está abierto, te añade en este mismo mensaje un contexto que empieza por "AgentCall:" con el estado resultante (y, si se activan, las reglas de las llamadas, que debes seguir desde ahora).

Responde con una sola línea breve en español confirmando el estado según ese contexto. No hagas nada más.

Si en este mensaje no hay ningún contexto que empiece por "AgentCall:", significa que AgentCall no está abierto: díselo al usuario en una línea y sugiérele abrirlo (acceso directo "AgentCall" del escritorio) y repetir el comando.
