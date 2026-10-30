---
description: AgentCall - llamadas de voz en esta sesion (on | off; sin argumento, estado)
argument-hint: on | off
disable-model-invocation: true
---
<!-- agentcall-saul-command: installed by AgentCall (better-call-claude) -->
El usuario ha escrito "/saul $ARGUMENTS" para activar o desactivar las llamadas de voz de AgentCall en esta sesión de Claude Code.

AgentCall procesa este comando por su cuenta (con "on" lo abre si estaba cerrado) y te añade en este mismo mensaje un contexto que empieza por "AgentCall:" con el estado resultante (y, si se activan, las reglas de las llamadas, que debes seguir desde ahora).

Responde con una sola línea breve en español confirmando el estado según ese contexto. No hagas nada más.

Si en este mensaje no hay ningún contexto que empiece por "AgentCall:", AgentCall no está disponible para esta sesión. Díselo al usuario en una línea: con "/saul on" se abre solo; si aun así no responde, que reinicie esta sesión de Claude Code (`claude --continue`) para cargar el plugin, o que lo instale.
