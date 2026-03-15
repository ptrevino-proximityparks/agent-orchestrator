# LINEAR-AUDIT.md — Auditoría del Plugin Linear y Event Bus

> Tarea 1.1 y 1.2 de la Fase 1 del AO-LINEAR Build Specification
> Fecha: 2026-03-15

---

## 1. INTERFAZ TRACKER (packages/core/src/types.ts)

### Definición Completa

```typescript
export interface Tracker {
  readonly name: string;

  /** Fetch issue details */
  getIssue(identifier: string, project: ProjectConfig): Promise<Issue>;

  /** Check if issue is completed/closed */
  isCompleted(identifier: string, project: ProjectConfig): Promise<boolean>;

  /** Generate a URL for the issue */
  issueUrl(identifier: string, project: ProjectConfig): string;

  /** Extract a human-readable label from an issue URL (e.g., "INT-1327", "#42") */
  issueLabel?(url: string, project: ProjectConfig): string;

  /** Generate a git branch name for the issue */
  branchName(identifier: string, project: ProjectConfig): string;

  /** Generate a prompt for the agent to work on this issue */
  generatePrompt(identifier: string, project: ProjectConfig): Promise<string>;

  /** Optional: list issues with filters */
  listIssues?(filters: IssueFilters, project: ProjectConfig): Promise<Issue[]>;

  /** Optional: update issue state */
  updateIssue?(identifier: string, update: IssueUpdate, project: ProjectConfig): Promise<void>;

  /** Optional: create a new issue */
  createIssue?(input: CreateIssueInput, project: ProjectConfig): Promise<Issue>;
}
```

### Tipos Relacionados

```typescript
export interface Issue {
  id: string;
  title: string;
  description: string;
  url: string;
  state: "open" | "in_progress" | "closed" | "cancelled";
  labels: string[];
  assignee?: string;
  priority?: number;
}

export interface IssueFilters {
  state?: "open" | "closed" | "all";
  labels?: string[];
  assignee?: string;
  limit?: number;
}

export interface IssueUpdate {
  state?: "open" | "in_progress" | "closed";
  labels?: string[];
  assignee?: string;
  comment?: string;  // ← IMPORTANTE: Ya soporta comentarios
}

export interface CreateIssueInput {
  title: string;
  description: string;
  labels?: string[];
  assignee?: string;
  priority?: number;
  // NOTA: NO tiene parentId para sub-issues
}
```

---

## 2. ESTADO ACTUAL DEL PLUGIN tracker-linear

### Ubicación
`packages/plugins/tracker-linear/src/index.ts` (722 líneas)

### Métodos Implementados

| Método | Estado | Líneas | Notas |
|--------|--------|--------|-------|
| `getIssue` | ✅ Implementado | 277-298 | Campos básicos: id, title, description, url, state, labels, assignee, priority |
| `isCompleted` | ✅ Implementado | 300-312 | Verifica state.type === "completed" \|\| "canceled" |
| `issueUrl` | ✅ Implementado | 314-322 | Usa workspaceSlug de config |
| `issueLabel` | ✅ Implementado | 324-336 | Extrae identifier de URL (ej: PP-45) |
| `branchName` | ✅ Implementado | 338-341 | Retorna `feat/{identifier}` |
| `generatePrompt` | ✅ Implementado | 343-376 | Prompt con título, labels, priority, descripción |
| `listIssues` | ✅ Implementado | 378-429 | Filtros: state, assignee, labels, teamId, limit |
| `updateIssue` | ✅ Implementado | 432-571 | State, assignee, labels, **comment** |
| `createIssue` | ✅ Implementado | 573-698 | Title, description, teamId, priority, labels, assignee |

### Análisis Detallado

#### getIssue — Campos Retornados

```typescript
// Campos actuales en ISSUE_FIELDS (líneas 256-267)
const ISSUE_FIELDS = `
  id
  identifier
  title
  description
  url
  priority
  state { name type }
  labels { nodes { name } }
  assignee { name displayName }
  team { key }
`;
```

**⚠️ FALTANTES para Linear-first:**
- `parent { id identifier title }` — para saber si es sub-issue
- `children { nodes { id identifier title state { name } } }` — sub-issues
- `comments { nodes { id body createdAt user { name } } }` — historial de comentarios
- `project { id name }` — proyecto asociado

#### updateIssue — Funcionalidad de Comentarios

```typescript
// Líneas 560-570 — YA implementado dentro de updateIssue
if (update.comment) {
  await query(
    `mutation($issueId: String!, $body: String!) {
      commentCreate(input: { issueId: $issueId, body: $body }) {
        success
      }
    }`,
    { issueId: issueUuid, body: update.comment },
  );
}
```

**✅ Los comentarios YA funcionan** vía `updateIssue(id, { comment: "texto" }, project)`

Sin embargo, para Linear-first necesitamos:
- Método `createComment()` standalone (más expresivo)
- Obtener el ID del comentario creado (para evitar duplicados)

#### createIssue — Sin Soporte para Sub-Issues

```typescript
// Línea 595-608 — Mutation actual
mutation($title: String!, $description: String!, $teamId: String!, $priority: Int) {
  issueCreate(input: {
    title: $title,
    description: $description,
    teamId: $teamId,
    priority: $priority
    // ⚠️ FALTA: parentId para sub-issues
  }) { ... }
}
```

---

## 3. COMPARACIÓN CON tracker-github (Referencia)

| Característica | tracker-github | tracker-linear |
|----------------|----------------|----------------|
| getIssue | Completo | Completo |
| isCompleted | ✅ | ✅ |
| issueUrl | ✅ | ✅ |
| issueLabel | ✅ | ✅ |
| branchName | ✅ | ✅ |
| generatePrompt | ✅ | ✅ |
| listIssues | ✅ | ✅ |
| updateIssue | ✅ (con gh CLI) | ✅ (GraphQL directo) |
| createIssue | ✅ | ✅ |
| **Comment standalone** | via gh issue comment | ❌ Solo vía updateIssue |
| **Sub-issues** | N/A (GitHub no tiene) | ❌ No implementado |

---

## 4. EVENT BUS Y SISTEMA DE EVENTOS

### Ubicación
`packages/core/src/lifecycle-manager.ts` (611 líneas)

### Arquitectura Actual

El sistema **NO usa un EventEmitter externo**. El flujo es:

```
pollAll()
  → checkSession(session)
    → determineStatus(session) // detecta nuevo estado
    → statusToEventType(old, new) // mapea a EventType
    → executeReaction() o notifyHuman() // acción directa
```

**Implicación**: Para agregar LinearReporter, debemos:
1. Crear un EventEmitter real y emitir eventos, O
2. Integrar LinearReporter directamente en lifecycle-manager, O
3. Crear un Notifier plugin que escriba a Linear

### EventType — Todos los Eventos Disponibles

```typescript
export type EventType =
  // Session lifecycle
  | "session.spawned"      // Cuando se crea una sesión
  | "session.working"      // Agente trabajando activamente
  | "session.exited"       // Proceso del agente terminó
  | "session.killed"       // Sesión terminada (runtime muerto o PR cerrado)
  | "session.stuck"        // Agente atascado (detectado por threshold)
  | "session.needs_input"  // Agente esperando input humano
  | "session.errored"      // Error en la sesión

  // PR lifecycle
  | "pr.created"           // PR creado
  | "pr.updated"           // PR actualizado
  | "pr.merged"            // PR mergeado
  | "pr.closed"            // PR cerrado sin merge

  // CI
  | "ci.passing"           // CI pasando
  | "ci.failing"           // CI fallando
  | "ci.fix_sent"          // Fix enviado al agente
  | "ci.fix_failed"        // Fix del agente falló

  // Reviews
  | "review.pending"             // Review pendiente
  | "review.approved"            // PR aprobado
  | "review.changes_requested"   // Cambios solicitados
  | "review.comments_sent"       // Comentarios enviados al agente
  | "review.comments_unresolved" // Comentarios sin resolver

  // Automated reviews
  | "automated_review.found"     // Bot/linter encontró issues
  | "automated_review.fix_sent"  // Fix enviado para issues automáticos

  // Merge
  | "merge.ready"          // Listo para merge
  | "merge.conflicts"      // Conflictos de merge
  | "merge.completed"      // Merge completado

  // Reactions
  | "reaction.triggered"   // Reacción ejecutada
  | "reaction.escalated"   // Reacción escalada a humano

  // Summary
  | "summary.all_complete" // Todas las sesiones completadas
```

### Mapeo Status → EventType (líneas 102-131)

```typescript
function statusToEventType(from, to): EventType | null {
  switch (to) {
    case "working":           return "session.working";
    case "pr_open":           return "pr.created";
    case "ci_failed":         return "ci.failing";
    case "review_pending":    return "review.pending";
    case "changes_requested": return "review.changes_requested";
    case "approved":          return "review.approved";
    case "mergeable":         return "merge.ready";
    case "merged":            return "merge.completed";
    case "needs_input":       return "session.needs_input";
    case "stuck":             return "session.stuck";
    case "errored":           return "session.errored";
    case "killed":            return "session.killed";
    default:                  return null;
  }
}
```

### Mapeo EventType → ReactionKey (líneas 134-157)

```typescript
function eventToReactionKey(eventType): string | null {
  switch (eventType) {
    case "ci.failing":                 return "ci-failed";
    case "review.changes_requested":   return "changes-requested";
    case "automated_review.found":     return "bugbot-comments";
    case "merge.conflicts":            return "merge-conflicts";
    case "merge.ready":                return "approved-and-green";
    case "session.stuck":              return "agent-stuck";
    case "session.needs_input":        return "agent-needs-input";
    case "session.killed":             return "agent-exited";
    case "summary.all_complete":       return "all-complete";
    default:                           return null;
  }
}
```

### ReactionConfig — Configuración de Reacciones

```typescript
export interface ReactionConfig {
  auto: boolean;                              // Habilitar reacción automática
  action: "send-to-agent" | "notify" | "auto-merge";
  message?: string;                           // Mensaje para send-to-agent
  priority?: EventPriority;                   // urgent | action | warning | info
  retries?: number;                           // Intentos antes de escalar
  escalateAfter?: number | string;            // "30m", "1h", o número de intentos
  threshold?: string;                         // Duración para triggers (ej: "10m")
  includeSummary?: boolean;
}
```

---

## 5. SISTEMA DE REACTIONS (Tarea 1.2)

### Flujo de Reactions

```
YAML config (reactions:)
       ↓
lifecycle-manager detecta transición de estado
       ↓
statusToEventType(old, new) → EventType
       ↓
eventToReactionKey(eventType) → reactionKey
       ↓
config.reactions[reactionKey] → ReactionConfig
       ↓
executeReaction(sessionId, projectId, key, config)
       ↓
┌─────────────────────────────────────────┐
│ switch (action):                         │
│   "send-to-agent" → sessionManager.send()│
│   "notify" → notifyHuman()               │
│   "auto-merge" → notifyHuman() (TODO)    │
└─────────────────────────────────────────┘
       ↓
Si retries excedidos o escalateAfter cumplido
       ↓
notifyHuman(reaction.escalated)
```

### Dónde Engancharse para Linear Reporting

**Opción A: Crear EventEmitter real (Recomendado)**

Modificar `lifecycle-manager.ts` para emitir eventos a un EventEmitter:

```typescript
// Nuevo en lifecycle-manager.ts
import { EventEmitter } from "node:events";

export function createLifecycleManager(deps) {
  const eventBus = new EventEmitter();

  // En checkSession(), después de detectar transición:
  if (eventType) {
    const event = createEvent(eventType, {...});
    eventBus.emit(eventType, event);  // ← NUEVO
    // ... resto del código existente
  }

  return {
    // ... métodos existentes
    eventBus,  // ← Exponer para LinearReporter
  };
}
```

**Opción B: Notifier Plugin**

Crear un notifier que escriba a Linear en vez de desktop/slack:

```typescript
// packages/plugins/notifier-linear/src/index.ts
export function create(): Notifier {
  return {
    name: "linear-comments",
    async notify(event) {
      // Postear comentario a Linear basado en event
    }
  };
}
```

**Opción C: Integración Directa**

Modificar `notifyHuman()` para también escribir a Linear cuando tracker es linear.

**Recomendación**: Opción A (EventEmitter) es la más limpia y extensible.

---

## 6. GAPS IDENTIFICADOS PARA LINEAR-FIRST

### En el Plugin tracker-linear

| Gap | Severidad | Solución |
|-----|-----------|----------|
| No hay `createComment()` standalone | Media | Extraer de updateIssue como método separado |
| No hay `createSubIssue()` | Alta | Agregar mutation con parentId |
| `updateIssueStatus()` no existe | Media | Crear método con cache de status IDs |
| `getIssue` no retorna sub-issues | Media | Agregar children al query |
| `getIssue` no retorna comentarios | Media | Agregar comments al query |
| No hay cache de workflow states | Baja | Implementar cache en memoria |

### En el Core (lifecycle-manager)

| Gap | Severidad | Solución |
|-----|-----------|----------|
| No hay EventEmitter real | Alta | Agregar y exponer eventBus |
| `session.spawned` no se emite | Media | Agregar en spawn flow |
| No hay hook para Linear reporting | Alta | LinearReporter class |

### En la Configuración

| Gap | Severidad | Solución |
|-----|-----------|----------|
| No hay sección `linear:` en YAML | Alta | Extender schema en config.ts |
| No hay `statusMapping` configurable | Media | Agregar a linear config |
| No hay `autoSpawn` config | Alta | Agregar trigger por webhook |

---

## 7. ARCHIVOS CLAVE PARA MODIFICAR

```
packages/
├── core/src/
│   ├── types.ts                    # (no modificar interfaz Tracker)
│   ├── lifecycle-manager.ts        # Agregar EventEmitter
│   ├── config.ts                   # Extender schema YAML
│   ├── linear-reporter.ts          # NUEVO: Event → Linear
│   └── auto-spawn.ts               # NUEVO: Webhook → Spawn
│
├── plugins/tracker-linear/src/
│   └── index.ts                    # Agregar métodos faltantes
│
└── dashboard/src/server/
    └── webhooks/
        └── linear.ts               # NUEVO: Webhook receiver
```

---

## 8. PRÓXIMOS PASOS

1. **Fase 2, Tarea 2.1**: Implementar `createComment()` como método standalone
2. **Fase 2, Tarea 2.2**: Implementar `createSubIssue()` con parentId
3. **Fase 2, Tarea 2.3**: Implementar `updateIssueStatus()` con cache
4. **Fase 2, Tarea 2.4**: Mejorar `getIssue()` con sub-issues y comentarios

---

## APÉNDICE: Transporte GraphQL

El plugin soporta dos transportes:

1. **Direct API** (LINEAR_API_KEY) — líneas 54-123
   - Usa `node:https` nativo
   - Timeout de 30s
   - Headers: `Authorization: {apiKey}`

2. **Composio SDK** (COMPOSIO_API_KEY) — líneas 131-205
   - Usa `@composio/core` SDK
   - Tool: `LINEAR_RUN_QUERY_OR_MUTATION`
   - Lazy-loading del cliente

Auto-detección en `create()` (líneas 713-720):
```typescript
export function create(): Tracker {
  const composioKey = process.env["COMPOSIO_API_KEY"];
  if (composioKey) {
    return createLinearTracker(createComposioTransport(composioKey, entityId));
  }
  return createLinearTracker(createDirectTransport());
}
```
