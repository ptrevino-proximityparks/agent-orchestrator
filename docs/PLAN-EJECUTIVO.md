# AO-LINEAR: Plan Ejecutivo de Implementación

> Documento de resumen y plan de acción basado en `AO-LINEAR-BUILD-SPEC.md`

---

## Objetivo

Transformar `agent-orchestrator` de un orquestador GitHub-centric a un **orquestador Linear-first** donde:

- **Linear es la fuente de verdad única** — issues, progreso, estados, todo vive en Linear
- **Agentes escriben a Linear** — comentarios, sub-issues, actualizaciones de estado, links a PRs
- **Webhooks bidireccionales** — Linear notifica a AO, AO notifica a Linear
- **Dashboard web opcional** — flujo diario vive en Linear, no en el dashboard

---

## Lo que NO cambiamos

| Componente | Razón |
|------------|-------|
| `packages/core/src/orchestrator.ts` | Lógica core intacta |
| `packages/plugins/agent-claude-code/` | Plugin de agente sin cambios |
| `packages/plugins/runtime-tmux/` | Runtime sin cambios |
| `packages/plugins/workspace-worktree/` | Workspace sin cambios |
| `packages/plugins/scm-github/` | SCM sin cambios |

---

## Componentes Nuevos a Construir

| Componente | Ubicación | Propósito |
|------------|-----------|-----------|
| **Linear Tracker mejorado** | `packages/plugins/tracker-linear/` | CRUD completo: comentarios, sub-issues, estados |
| **LinearReporter** | `packages/core/src/linear-reporter.ts` | Event bus → Linear mapping |
| **Webhook receiver** | `packages/dashboard/src/server/webhooks/` | Endpoint HTTP para webhooks de Linear |
| **AutoSpawn handler** | `packages/core/src/auto-spawn.ts` | Webhook → trigger de spawn |
| **CLAUDE.md template** | `templates/CLAUDE.md.template` | Comportamiento estándar de agentes |
| **YAML schema extendido** | `packages/core/src/config.ts` | Nueva sección `linear:` |
| **`ao init --tracker linear`** | `packages/cli/src/commands/init.ts` | Flag para proyectos Linear |

---

## Fases de Implementación

### FASE 1: AUDITORÍA (Tareas 1.1-1.2) ✅ COMPLETADA
**Objetivo**: Entender qué existe antes de construir

- [x] **1.1** Documentar interfaz `Tracker` y estado actual del plugin Linear
- [x] **1.2** Documentar sistema de reactions y event bus

**Entregable**: `docs/LINEAR-AUDIT.md`

---

### FASE 2: TRACKER PLUGIN (Tareas 2.1-2.4) ✅ COMPLETADA
**Objetivo**: Hacer el plugin Linear fully-functional

- [x] **2.1** Implementar `createComment()` — ya existía, verificado funcional
- [x] **2.2** Implementar `createSubIssue()` — sub-issues con parentId
- [x] **2.3** Implementar `updateIssueStatus()` — transiciones con cache de workflow states
- [x] **2.4** Implementar `getIssueWithContext()` — contexto completo para agentes

**Commit**: `feat(linear): Phase 2 - Enhanced tracker plugin for Linear-first workflows`

---

### FASE 3: LINEAR REPORTER (Tareas 3.1-3.2) ✅ COMPLETADA
**Objetivo**: Reportar eventos del orquestador a Linear automáticamente

- [x] **3.1** Crear clase `LinearReporter` — packages/core/src/linear-reporter.ts
- [x] **3.2** Integrar LinearReporter en lifecycle-manager.ts

**Eventos implementados**:
- `session.spawned` → comentario + status "In Progress"
- `ci.failing` → comentario con checks fallidos
- `pr.created` → comentario con link al PR + status "In Review"
- `pr.merged` → comentario + status "Done"
- `session.stuck`, `session.needs_input`, `session.errored` → comentarios de alerta

**Commit**: `feat(linear): Phase 3 - LinearReporter for automatic event reporting`

---

### FASE 4: WEBHOOKS (Tareas 4.1-4.2) ✅ COMPLETADA
**Objetivo**: Linear puede triggear acciones en AO

- [x] **4.1** Endpoint `POST /webhooks/linear` — validación de firma, emit eventos
- [x] **4.2** AutoSpawn handler — status change → spawn automático

**Implementado**:
- Verificación HMAC-SHA256 con timing-safe comparison
- AutoSpawn en transición a status "Todo", "Ready", etc.
- Prevención de loops: detecta comentarios de bot, usuario API
- Prevención de duplicados: no spawn si ya existe sesión activa

**Commit**: `feat(linear): Phase 4 - Webhooks and AutoSpawn handler`

---

### FASE 5: CONFIGURACIÓN (Tareas 5.1-5.3) ✅ COMPLETADA
**Objetivo**: YAML config completa para Linear-first mode

- [x] **5.1** Extender schema YAML con sección `linear:`
- [x] **5.2** Wiring de resolución de proyecto en AutoSpawn
- [x] **5.3** `ao init --tracker linear` genera config correcta

**Implementado**:
- LinearConfig type en types.ts
- LinearConfigSchema con validación Zod
- LinearReporter usa config global + override por proyecto
- AutoSpawn usa config.linear.autoSpawn
- `ao init --auto --tracker linear` genera config completa

**Nueva estructura YAML**:
```yaml
linear:
  webhooks:
    enabled: true
    path: /webhooks/linear
  statusMapping:
    agent-spawned: In Progress
    pr-created: In Review
    pr-merged: Done
  comments:
    enabled: true
    prefix: "🤖"
  autoSpawn:
    enabled: true
    triggerStatus: Todo
```

**Commit**: `feat(linear): Phase 5 - Configuration and CLI enhancements`

---

### FASE 6: TEMPLATES Y DOCS (Tareas 6.1-6.3) ✅ COMPLETADA
**Objetivo**: Documentación y plantillas

- [x] **6.1** `templates/CLAUDE.md.template` — instrucciones para agentes
- [x] **6.2** `examples/linear-first.yaml` — config de ejemplo
- [x] **6.3** Actualizar README, SETUP, crear `docs/LINEAR-FIRST.md`

**Entregables**:
- `templates/CLAUDE.md.template` — Instrucciones estándar para agentes Linear-first
- `examples/linear-first.yaml` — Configuración completa de ejemplo
- `docs/LINEAR-FIRST.md` — Documentación completa con Quick Start, configuración, troubleshooting
- README.md actualizado con Option C (Linear-first) y link a docs
- SETUP.md actualizado con sección Linear-First Mode

**Commit**: `docs(linear): Phase 6 - Templates and documentation`

---

### FASE 7: INTEGRATION TESTS (Tarea 7.1)
**Objetivo**: Validar el sistema completo

- [ ] **7.1** Suite de tests en `tests/integration/linear/`

**Tests a crear**:
- `comment.test.ts` — createComment
- `subissue.test.ts` — createSubIssue
- `status.test.ts` — updateIssueStatus
- `reporter.test.ts` — eventos → comentarios
- `webhook.test.ts` — validación firma + emit
- `autospawn.test.ts` — status change → spawn
- `loop-prevention.test.ts` — sin loops infinitos
- `lifecycle.test.ts` — spawn → merge → done

---

## Datos de Referencia (Linear Workspace)

```yaml
team:
  name: ProximityParks
  id: d74813c3-16ef-4b18-9a66-ebf976ea4ce4

statuses:
  Backlog: e2abe3a8-60b1-4aba-8d1f-a786f3dbb372
  Todo: a0f74d52-0021-42fa-8f95-56f9f88cfafb
  In Progress: 93c27041-b427-4e9c-90a4-a61d04c7bf38
  In Review: 55e6343a-64a5-4fa1-ad00-9d3b3d31f824
  Done: e50a3a2c-5e94-44eb-96aa-5cc040ae8ead
```

---

## Reglas de Ejecución

1. **Orden estricto** — cada tarea depende de la anterior
2. **Build + Test después de cada tarea** — `pnpm build && pnpm test`
3. **Commit después de cada tarea** — `feat(linear): [descripción]`
4. **No modificar core** — solo extender con nuevos módulos
5. **Mocks en tests** — nunca llamar API real de Linear en tests

---

## Próximo Paso

**Iniciar con FASE 1, Tarea 1.1**: Auditar la interfaz `Tracker` y el estado actual del plugin `tracker-linear`.

```bash
# Archivos a leer primero:
packages/core/src/types.ts          # Interfaz Tracker
packages/plugins/tracker-github/    # Implementación de referencia
packages/plugins/tracker-linear/    # Estado actual
packages/core/src/events.ts         # Event bus (si existe)
```

---

## Checklist General

```
[ ] FASE 1: Auditoría (1.1, 1.2)
[ ] FASE 2: Tracker plugin (2.1, 2.2, 2.3, 2.4)
[ ] FASE 3: Reporter module (3.1, 3.2)
[ ] FASE 4: Webhooks (4.1, 4.2)
[ ] FASE 5: Config y CLI (5.1, 5.2, 5.3)
[ ] FASE 6: Templates y docs (6.1, 6.2, 6.3)
[ ] FASE 7: Integration tests (7.1)
```
