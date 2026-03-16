# Agent Orchestrator — Guia de Uso con Linear

## Que es Agent Orchestrator?

Sistema para orquestar agentes de IA (Claude Code, Codex, Aider) en paralelo. Creas issues en Linear, lanzas agentes que trabajan en cada issue, y el sistema gestiona worktrees, PRs, CI, y te notifica cuando necesita tu atencion.

**Principio: Push, not pull.** Lanzas agentes, te vas, y te notifica cuando necesita tu juicio.

---

## Requisitos previos

| Requisito | Verificar | Instalar |
|-----------|-----------|----------|
| Node 20+ | `node -v` | `brew install node` |
| pnpm | `pnpm -v` | `npm install -g pnpm` |
| tmux | `tmux -V` | `brew install tmux` |
| GitHub CLI | `gh auth status` | `brew install gh && gh auth login` |
| Claude Code | `claude --version` | `npm install -g @anthropic-ai/claude-code` |

---

## Configuracion inicial (ya realizada)

### 1. Variables de entorno (`~/.zshrc`)

```bash
export LINEAR_API_KEY="lin_api_xxxxxxxxxxxxxxxxxxxxxxx"
```

Despues de agregar, ejecutar: `source ~/.zshrc`

### 2. Archivo de configuracion

El archivo `agent-orchestrator.yaml` en la raiz del repo:

```yaml
dataDir: ~/.ao-sessions          # Donde se guardan metadatos de sesiones
worktreeDir: ~/.worktrees/ao     # Donde se crean worktrees (copias del repo)

defaults:
  runtime: tmux                  # Cada agente corre en una sesion tmux
  agent: claude-code             # Agente de IA por defecto
  workspace: worktree            # Aislamiento via git worktrees
  notifiers: [desktop]           # Notificaciones de escritorio

projects:
  ao:                            # ID del proyecto (lo usas en comandos)
    name: Agent Orchestrator
    repo: ptrevino-proximityparks/agent-orquestrator
    path: ~/Projects/agent-orquestrator
    defaultBranch: main
    sessionPrefix: ao
    scm:
      plugin: github
    tracker:
      plugin: linear
      teamId: "d74813c3-16ef-4b18-9a66-ebf976ea4ce4"  # Team ProximityParks
    symlinks: [.claude]          # Archivos a copiar en worktrees
    postCreate:
      - "pnpm install"           # Ejecutar despues de crear worktree
    agentConfig:
      permissions: skip          # --dangerously-skip-permissions
```

### 3. Mapeo de estados Linear <-> Orchestrator

| Estado Linear | Tipo | Cuando se usa |
|---------------|------|---------------|
| Backlog | backlog | Issue pendiente, sin prioridad |
| Todo | unstarted | Issue lista para trabajar |
| In Progress | started | Agente trabajando |
| In Review | started | PR creado, esperando review |
| Done | completed | PR mergeado |
| Canceled | canceled | Issue cancelado |

El orquestador actualiza automaticamente el estado en Linear:
- Agente spawned → **In Progress**
- PR creado → **In Review**
- PR mergeado → **Done**

---

## Comandos principales

### Ver estado de sesiones

```bash
ao status
```

Muestra todas las sesiones activas con: branch, PR, CI status, actividad del agente.

### Crear un issue en Linear y lanzar un agente

**Paso 1**: Crea el issue en Linear (desde la app o MCP) con tu tarea.

**Paso 2**: Lanza el agente con el ID del issue:

```bash
# Sesion individual
ao spawn ao PRO-5

# Abrir en tab de terminal automaticamente
ao spawn ao PRO-5 --open

# Usar un agente diferente (ej: codex en lugar de claude-code)
ao spawn ao PRO-5 --agent codex
```

**Paso 3**: El orquestador:
1. Crea un git worktree (copia aislada del repo)
2. Ejecuta `pnpm install` en el worktree
3. Abre una sesion tmux
4. Lanza Claude Code con el prompt del issue
5. Actualiza el estado en Linear a "In Progress"

### Lanzar multiples agentes en paralelo

```bash
# Lanzar agentes para 3 issues a la vez
ao batch-spawn ao PRO-5 PRO-6 PRO-7
```

El sistema detecta duplicados automaticamente (no lanza 2 agentes para el mismo issue).

### Enviar mensaje a un agente

```bash
# Enviar instruccion adicional
ao send ao-5 "focus on the login component first"

# Enviar contenido de un archivo
ao send ao-5 -f instructions.md
```

### Gestionar sesiones

```bash
# Listar sesiones
ao session ls

# Matar una sesion (elimina worktree tambien)
ao session kill ao-5

# Restaurar sesion crasheada
ao session restore ao-5

# Limpiar sesiones terminadas (PR mergeado o issue cerrado)
ao session cleanup
```

### Dashboard web

```bash
# Iniciar dashboard en http://localhost:3000
ao dashboard

# O con el orquestador automatico incluido
ao start ao
```

### Conectarse a una sesion tmux

```bash
# Ver la sesion del agente en vivo
tmux attach -t ao-5
```

Para salir de tmux sin matar la sesion: `Ctrl+B` luego `D`.

### Revisar PRs con review comments

```bash
# Checa si hay review comments y envia al agente para que los resuelva
ao review-check ao
```

---

## Flujo de trabajo tipico

```
1. Crear issues en Linear (Backlog/Todo)
       |
2. ao batch-spawn ao PRO-5 PRO-6 PRO-7
       |
3. Agentes trabajan en paralelo (cada uno en su worktree)
       |
4. ao status  (ver progreso)
       |
5. Agente crea PR → Linear pasa a "In Review"
       |
6. Tu revisas PR en GitHub
       |
7. Si hay comments → ao review-check ao  (agente los resuelve)
       |
8. Apruebas y mergeas → Linear pasa a "Done"
       |
9. ao session cleanup  (limpia worktrees terminados)
```

---

## Agregar nuevos proyectos

Edita `agent-orchestrator.yaml` y agrega bajo `projects:`:

```yaml
projects:
  ao:
    # ... config existente ...

  mi-otro-repo:
    name: Mi Otro Proyecto
    repo: ptrevino-proximityparks/mi-otro-repo
    path: ~/Projects/mi-otro-repo
    defaultBranch: main
    sessionPrefix: mor
    scm:
      plugin: github
    tracker:
      plugin: linear
      teamId: "d74813c3-16ef-4b18-9a66-ebf976ea4ce4"
    postCreate:
      - "npm install"
```

---

## Troubleshooting

### "LINEAR_API_KEY environment variable is required"
```bash
echo $LINEAR_API_KEY  # Deberia mostrar tu key
source ~/.zshrc       # Recargar si esta vacio
```

### "Unknown project: xxx"
Verifica que el project ID coincida con lo que esta en `agent-orchestrator.yaml` bajo `projects:`.

### Sesion tmux no responde
```bash
ao session kill ao-5       # Mata la sesion
ao spawn ao PRO-5          # Re-lanza
```

### Worktrees acumulados
```bash
ao session cleanup          # Limpia sesiones terminadas
git worktree list           # Ver worktrees activos
git worktree remove <path>  # Eliminar manualmente
```

### Build necesario antes del dashboard
```bash
pnpm build                  # Compilar todos los paquetes
ao dashboard                # Luego iniciar dashboard
```

---

## Referencia rapida

| Accion | Comando |
|--------|---------|
| Ver estado | `ao status` |
| Lanzar 1 agente | `ao spawn ao PRO-XX` |
| Lanzar N agentes | `ao batch-spawn ao PRO-5 PRO-6 PRO-7` |
| Enviar mensaje | `ao send ao-5 "haz esto"` |
| Ver sesion | `tmux attach -t ao-5` |
| Matar sesion | `ao session kill ao-5` |
| Restaurar sesion | `ao session restore ao-5` |
| Limpiar terminadas | `ao session cleanup` |
| Revisar PRs | `ao review-check ao` |
| Dashboard | `ao dashboard` |
| Iniciar todo | `ao start ao` |
| Detener todo | `ao stop ao` |
