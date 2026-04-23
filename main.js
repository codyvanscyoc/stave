const { app, BrowserWindow, Tray, Menu, MenuItem, globalShortcut, nativeImage, screen, ipcMain, Notification } = require('electron')
const path = require('path')
const fs = require('fs')
const os = require('os')
const nspell = require('nspell')
const dictionaryEn = require('dictionary-en')

let speller = null
dictionaryEn((err, dict) => {
  if (!err) speller = nspell(dict)
})

let tray = null
let win = null
let searchWin = null
let remindersWin = null
let winMode = 'hide'

const NOTES_DIR = process.platform === 'win32'
  ? path.join(os.homedir(), fs.existsSync(path.join(os.homedir(), 'OneDrive')) ? 'OneDrive' : 'Documents', 'Stave')
  : process.platform === 'linux'
    ? path.join(os.homedir(), 'Documents', 'Stave')
    : path.join(os.homedir(), 'Library', 'Mobile Documents', 'com~apple~CloudDocs', 'Stave')
const WRITE_DIR = path.join(NOTES_DIR, 'write')
const PLAN_DIR  = path.join(NOTES_DIR, 'plan')
const PREFS_FILE = path.join(NOTES_DIR, 'prefs.json')

const DEFAULT_PREFS = { width: 420, height: 750, posX: null, posY: null, winMode: process.platform === 'darwin' ? 'hide' : 'free' }

function loadPrefs() {
  try {
    if (fs.existsSync(PREFS_FILE))
      return { ...DEFAULT_PREFS, ...JSON.parse(fs.readFileSync(PREFS_FILE, 'utf8')) }
  } catch(e) { console.error('[loadPrefs] failed:', e) }
  return { ...DEFAULT_PREFS }
}

function savePrefs(data) {
  try { fs.writeFileSync(PREFS_FILE, JSON.stringify(data, null, 2), 'utf8') }
  catch(e) { console.error('[savePrefs] failed:', e) }
}

const LONGFORM_DIR = path.join(NOTES_DIR, 'longform')
const PROJECTS_DIR = path.join(NOTES_DIR, 'projects')

function ensureDirs() {
  ;[NOTES_DIR, WRITE_DIR, PLAN_DIR, LONGFORM_DIR, PROJECTS_DIR].forEach(d => {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true })
  })
}

// Foreign-file guard (matches renderer.js). Lockin IPC write handlers
// use this to refuse any write outside Stave's notes dirs.
function isInStaveNotesDir(filepath) {
  if (!filepath) return false
  const abs = path.resolve(filepath)
  return [WRITE_DIR, PLAN_DIR, LONGFORM_DIR, PROJECTS_DIR].some(d => {
    const prefix = path.resolve(d) + path.sep
    return abs === path.resolve(d) || abs.startsWith(prefix)
  })
}

function createWindow() {
  const prefs = loadPrefs()
  winMode = prefs.winMode || 'hide'

  win = new BrowserWindow({
    width: prefs.width || 420,
    height: prefs.height || 750,
    show: false,
    frame: false,
    resizable: true,
    transparent: false,
    backgroundColor: '#1c1c1e',
    alwaysOnTop: winMode === 'float',
    skipTaskbar: winMode !== 'free',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      spellcheck: true
    }
  })

  win.loadFile('index.html')
  win.webContents.session.setSpellCheckerLanguages(['en-US'])
  win.webContents.once('did-finish-load', () => {
    if (pendingFilePath) {
      win.show()
      win.focus()
      win.webContents.send('open-file-path', pendingFilePath)
      pendingFilePath = null
    }
  })
  win.on('blur', () => { if (winMode === 'hide') win.hide() })
  win.on('resize', () => {
    const [w, h] = win.getSize()
    savePrefs({ ...loadPrefs(), width: w, height: h })
  })
  win.on('move', () => {
    const [x, y] = win.getPosition()
    savePrefs({ ...loadPrefs(), posX: x, posY: y })
  })
}

function createTray() {
  const icon = process.platform === 'win32'
    ? nativeImage.createFromPath(path.join(__dirname, 'icon.png'))
    : nativeImage.createEmpty()
  tray = new Tray(icon)
  if (process.platform !== 'win32') tray.setTitle('S†')
  tray.setToolTip('S†AVE')
  tray.on('click', () => toggleWindow())
  tray.on('right-click', () => buildTrayMenu())
}

function buildTrayMenu() {
  const writeNotes = getNotesList('write').slice(0, 8).map(n => ({
    label: formatNoteLabel(n, 'write'),
    click: () => {
      if (win) {
        win.webContents.send('load-note', { filename: n, mode: 'write' })
        if (!win.isVisible()) toggleWindow()
      }
    }
  }))

  const planNotes = getNotesList('plan').slice(0, 8).map(n => ({
    label: formatNoteLabel(n, 'plan'),
    click: () => {
      if (win) {
        win.webContents.send('load-note', { filename: n, mode: 'plan' })
        if (!win.isVisible()) toggleWindow()
      }
    }
  }))

  const menu = Menu.buildFromTemplate([
    { label: 'S†AVE', enabled: false },
    { type: 'separator' },
    { label: 'write notes', enabled: false },
    ...writeNotes,
    { type: 'separator' },
    { label: 'plan notes', enabled: false },
    ...planNotes,
    { type: 'separator' },
    { label: 'New Write Note', click: () => {
      if (win) { win.webContents.send('new-note', 'write'); if (!win.isVisible()) toggleWindow() }
    }},
    { label: 'New Plan Note', click: () => {
      if (win) { win.webContents.send('new-note', 'plan'); if (!win.isVisible()) toggleWindow() }
    }},
    { type: 'separator' },
    { label: 'Search Notes', click: () => openSearch() },
    { label: 'Reminders', click: () => openReminders() },
    { type: 'separator' },
    { label: 'Quit S†AVE', click: () => app.exit(0) }
  ])
  tray.popUpContextMenu(menu)
}

function formatNoteLabel(filename, mode) {
  try {
    const dir = mode === 'write' ? WRITE_DIR : PLAN_DIR
    const raw = fs.readFileSync(path.join(dir, filename), 'utf8')
    const titleLine = raw.split('\n').find(l => l.startsWith('# '))
    const title = titleLine ? titleLine.slice(2).trim() : ''
    const stat = fs.statSync(path.join(dir, filename))
    const d = new Date(stat.mtime)
    const dateStr = `${(d.getMonth()+1).toString().padStart(2,'0')}/${d.getDate().toString().padStart(2,'0')}/${d.getFullYear().toString().slice(2)}`
    const label = title || dateStr
    return `${mode === 'write' ? '✦' : '◆'} ${label.slice(0, 32)}`
  } catch(e) { return filename.replace('.md','') }
}

function getNotesList(mode) {
  const LONGFORM_DIR = path.join(NOTES_DIR, 'longform')
  const PROJECTS_DIR = path.join(NOTES_DIR, 'projects')
  let dir
  if (mode === 'plan') dir = PLAN_DIR
  else if (mode === 'longform') dir = LONGFORM_DIR
  else if (mode === 'project') dir = PROJECTS_DIR
  else dir = WRITE_DIR
  try {
    return fs.readdirSync(dir)
      .filter(f => f.endsWith('.md'))
      .sort((a, b) => {
        const sa = fs.statSync(path.join(dir, a)).mtime
        const sb = fs.statSync(path.join(dir, b)).mtime
        return sb - sa
      })
  } catch(e) { return [] }
}

function toggleWindow() {
  if (!win || win.isDestroyed()) return
  if (win.isVisible() && winMode === 'hide') {
    win.hide()
  } else {
    positionWindow()
    app.focus({ steal: true })
    win.show()
    win.focus()
  }
}

function positionWindow() {
  if (!win || win.isDestroyed()) return
  const prefs = loadPrefs()
  const cursor = screen.getCursorScreenPoint()
  const display = screen.getDisplayNearestPoint(cursor)
  const { workArea } = display

  if (prefs.posX !== null && prefs.posY !== null) {
    // check if saved position is on any connected display
    const savedDisplay = screen.getDisplayNearestPoint({ x: prefs.posX, y: prefs.posY })
    const allDisplays = screen.getAllDisplays()
    const onValidDisplay = allDisplays.some(d => d.id === savedDisplay.id)
    if (onValidDisplay) {
      win.setPosition(prefs.posX, prefs.posY)
      return
    }
  }

  const wb = win.getBounds()
  win.setPosition(
    workArea.x + workArea.width - wb.width - 10,
    workArea.y + 10
  )
}

function openSearch() {
  if (searchWin && !searchWin.isDestroyed()) { searchWin.focus(); return }
  const winBounds = win.getBounds()
  const display = require('electron').screen.getDisplayNearestPoint({ x: winBounds.x, y: winBounds.y })
  searchWin = new BrowserWindow({
    width: 500, height: 700, show: false, frame: false,
    resizable: true, backgroundColor: '#1c1c1e', alwaysOnTop: true,
    x: display.workArea.x + Math.round((display.workArea.width - 500) / 2),
    y: display.workArea.y + Math.round((display.workArea.height - 700) / 2),
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  })
  searchWin.loadFile('search.html')
  searchWin.once('ready-to-show', () => { searchWin.show(); searchWin.focus() })
  searchWin.on('blur', () => { if (searchWin && !searchWin.isDestroyed()) searchWin.close() })
}
let lockInWin = null

function openLockIn(mode, content, title, filepath, recordings) {
  if (lockInWin && !lockInWin.isDestroyed()) {
    lockInWin.focus()
    return
  }
  lockInWin = new BrowserWindow({
    fullscreen: true,
    show: false,
    frame: false,
    backgroundColor: '#1c1c1e',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  })
  lockInWin.loadFile('lockin.html')
  lockInWin.once('ready-to-show', () => {
    lockInWin.show()
    lockInWin.focus()
    lockInWin.webContents.send('init-lockin', { mode, content, title, filepath, recordings: recordings || [] })
  })
  lockInWin.on('closed', () => { lockInWin = null })
}
function openReminders() {
  if (remindersWin && !remindersWin.isDestroyed()) { remindersWin.focus(); return }
  const winBounds = win.getBounds()
  const display = require('electron').screen.getDisplayNearestPoint({ x: winBounds.x, y: winBounds.y })
  remindersWin = new BrowserWindow({
    width: 420, height: 500, show: false, frame: false,
    resizable: true, backgroundColor: '#1c1c1e', alwaysOnTop: true,
    x: display.workArea.x + Math.round((display.workArea.width - 420) / 2),
    y: display.workArea.y + Math.round((display.workArea.height - 500) / 2),
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  })
  remindersWin.loadFile('reminders.html')
  remindersWin.once('ready-to-show', () => { remindersWin.show(); remindersWin.focus() })
  remindersWin.on('blur', () => { if (remindersWin && !remindersWin.isDestroyed()) remindersWin.close() })
}

// ── IPC ──
ipcMain.on('open-search', () => openSearch())
ipcMain.on('open-reminders', () => openReminders())
ipcMain.on('open-lockin', (event, data) => openLockIn(data.mode, data.content, data.title, data.filepath, data.recordings))
let lockInPlanWin = null

ipcMain.on('open-lockin-plan', (event, data) => {
  if (lockInPlanWin && !lockInPlanWin.isDestroyed()) {
    lockInPlanWin.focus(); return
  }
  lockInPlanWin = new BrowserWindow({
    fullscreen: true, show: false, frame: false,
    backgroundColor: '#1c1c1e',
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  })
  lockInPlanWin.loadFile('lockin-plan.html')
  lockInPlanWin.once('ready-to-show', () => {
    lockInPlanWin.show()
    lockInPlanWin.focus()
    lockInPlanWin.webContents.send('init-lockin-plan', data)
  })
  lockInPlanWin.on('closed', () => { lockInPlanWin = null })
})

ipcMain.on('close-lockin-plan', (event, data) => {
  if (win) win.webContents.send('lockin-plan-closed', data)
  if (lockInPlanWin && !lockInPlanWin.isDestroyed()) lockInPlanWin.close()
})
ipcMain.on('switch-plan-tab', (event, { index }) => {
  if (win) {
    win.webContents.send('reload-lockin-plan', { index })
  }
})

ipcMain.on('push-lockin-plan-data', (event, data) => {
  if (lockInPlanWin && !lockInPlanWin.isDestroyed()) {
    lockInPlanWin.webContents.send('init-lockin-plan', data)
  }
})
ipcMain.on('lockin-plan-save', (event, { filepath, content }) => {
  if (!isInStaveNotesDir(filepath)) {
    console.error('[lockin-plan-save] REFUSED foreign filepath:', filepath)
    return
  }
  try { fs.writeFileSync(filepath, content, 'utf8') }
  catch(e) { console.error('[lockin-plan-save] write failed:', e) }
})

ipcMain.on('open-project-folder', (event, folderPath) => {
  require('electron').shell.openPath(folderPath)
})

ipcMain.on('get-all-projects', (event) => {
  const projectsDir = path.join(NOTES_DIR, 'projects')
  try {
    if (!fs.existsSync(projectsDir)) fs.mkdirSync(projectsDir, { recursive: true })
    const files = fs.readdirSync(projectsDir).filter(f => f.endsWith('.md'))
    const projects = files.map(f => {
      const raw = fs.readFileSync(path.join(projectsDir, f), 'utf8')
      const titleLine = raw.split('\n').find(l => l.startsWith('# '))
      return {
        filename: f,
        filepath: path.join(projectsDir, f),
        title: titleLine ? titleLine.slice(2).trim() : f.replace('.md','')
      }
    })
    event.reply('all-projects', projects)
  } catch(e) { event.reply('all-projects', []) }
})
ipcMain.on('close-lockin', (event, updatedContent) => {
  if (win) win.webContents.send('lockin-closed', updatedContent)
  if (lockInWin && !lockInWin.isDestroyed()) lockInWin.close()
})

// Show a file-picker on behalf of a lockin window and return the file's
// contents as text. This is how users bring external .md / .txt files into
// the current note — the source file is only READ, never attached as a tab
// filepath (which would otherwise put it on the autosave rewrite path).
ipcMain.on('import-file-dialog', (event) => {
  const { dialog } = require('electron')
  const senderWin = BrowserWindow.fromWebContents(event.sender)
  const opts = {
    title: 'Import text into note',
    properties: ['openFile'],
    filters: [
      { name: 'Text / Markdown', extensions: ['md', 'txt', 'markdown'] },
      { name: 'All files', extensions: ['*'] }
    ]
  }
  const picked = senderWin
    ? dialog.showOpenDialogSync(senderWin, opts)
    : dialog.showOpenDialogSync(opts)
  if (!picked || !picked.length) {
    event.sender.send('import-file-result', null)
    return
  }
  const filePath = picked[0]
  try {
    const raw = fs.readFileSync(filePath, 'utf8')
    const basename = path.basename(filePath)
    event.sender.send('import-file-result', { content: raw, basename })
  } catch(e) {
    console.error('[import-file-dialog] read failed:', e)
    event.sender.send('import-file-result', null)
  }
})

ipcMain.on('lockin-save', (event, { filepath, content }) => {
  if (!isInStaveNotesDir(filepath)) {
    console.error('[lockin-save] REFUSED foreign filepath:', filepath)
    return
  }
  try { fs.writeFileSync(filepath, content, 'utf8') }
  catch(e) { console.error('[lockin-save] write failed:', e) }
})
ipcMain.on('lockin-drawer-lookup', (event, word) => {
  if (win) win.webContents.send('drawer-lookup', word)
})

ipcMain.on('lockin-drawer-results', (event, data) => {
  if (lockInWin && !lockInWin.isDestroyed()) {
    lockInWin.webContents.send('drawer-results', data)
  }
})
ipcMain.on('lockin-recordings-update', (event, recordings) => {
  if (win) win.webContents.send('lockin-recordings-update', recordings)
})
ipcMain.on('close-search', () => {
  if (searchWin && !searchWin.isDestroyed()) searchWin.close()
})

ipcMain.on('close-reminders', () => {
  if (remindersWin && !remindersWin.isDestroyed()) remindersWin.close()
})

ipcMain.on('search-open-note', (event, { filename, mode }) => {
  if (win) {
    win.webContents.send('load-note', { filename, mode })
    if (!win.isVisible()) toggleWindow()
  }
  if (searchWin && !searchWin.isDestroyed()) searchWin.close()
  if (remindersWin && !remindersWin.isDestroyed()) remindersWin.close()
})

ipcMain.on('get-all-notes', (event) => {
  const LONGFORM_DIR = path.join(NOTES_DIR, 'longform')
  const PROJECTS_DIR = path.join(NOTES_DIR, 'projects')
  const writeNotes    = getNotesList('write').map(f =>    ({ filename: f, mode: 'write',    dir: WRITE_DIR    }))
  const planNotes     = getNotesList('plan').map(f =>     ({ filename: f, mode: 'plan',     dir: PLAN_DIR     }))
  const projectNotes  = getNotesList('project').map(f =>  ({ filename: f, mode: 'project',  dir: PROJECTS_DIR }))
  const all = [...writeNotes, ...planNotes, ...projectNotes].map(n => {
    try {
      const raw = fs.readFileSync(path.join(n.dir, n.filename), 'utf8')
const titleLine = raw.split('\n').find(l => l.startsWith('# '))
const typeLine = raw.split('\n').find(l => l.startsWith('type: '))
const title = titleLine ? titleLine.slice(2).trim() : n.filename.replace('.md','')
const noteMode = typeLine ? typeLine.slice(5).trim() : n.mode
const stat = fs.statSync(path.join(n.dir, n.filename))
return { filename: n.filename, mode: noteMode, filepath: path.join(n.dir, n.filename), title, raw, mtime: stat.mtime }
    } catch(e) { return null }
  }).filter(Boolean).sort((a,b) => new Date(b.mtime) - new Date(a.mtime))
  event.reply('all-notes', all)
})

ipcMain.on('get-all-reminders', (event) => {
  const allReminders = []
  const now = new Date()
  ;['write','plan'].forEach(mode => {
    const dir = mode === 'plan' ? PLAN_DIR : WRITE_DIR
    try {
      const files = fs.readdirSync(dir).filter(f => f.endsWith('.md'))
      files.forEach(filename => {
        const raw = fs.readFileSync(path.join(dir, filename), 'utf8')
        const titleLine = raw.split('\n').find(l => l.startsWith('# '))
        const noteTitle = titleLine ? titleLine.slice(2).trim() : filename.replace('.md','')
        const lines = raw.split('\n')
        // Two-pass: first collect phase metadata (so `status: done` after the
        // deadline line is visible at emit time), then emit reminders.
        const phaseMeta = []        // { name, deadline, done }
        let inPhases = false
        let cur = null
        lines.forEach(line => {
          if (line === '## phases') { inPhases = true; return }
          if (line.startsWith('## ') && line !== '## phases') { inPhases = false; cur = null; return }
          if (!inPhases) return
          if (line.startsWith('### ')) {
            cur = { name: line.slice(4).trim(), deadline: null, done: false }
            phaseMeta.push(cur)
          } else if (cur && line.startsWith('deadline: ')) {
            cur.deadline = line.slice(10).trim()
          } else if (cur && line.startsWith('status: ')) {
            cur.done = line.slice(8).trim() === 'done'
          }
        })
        phaseMeta.forEach(p => {
          if (!p.deadline) return
          const isoString = p.deadline + 'T23:59:00'
          const deadlineTime = new Date(isoString)
          if (isNaN(deadlineTime)) return
          allReminders.push({
            taskText: p.name,
            noteTitle, filename, mode, isoString,
            isPast: deadlineTime < now,
            done: p.done,
            isPhaseDeadline: true,
          })
        })

        // Task-level reminders (top-level only — phase tasks can't carry reminders today)
        let currentTask = null
        let sawPhases = false
        lines.forEach(line => {
          if (line === '## phases') { sawPhases = true; return }
          if (sawPhases) return
          if (line.startsWith('- [ ] ') || line.startsWith('- [x] ')) {
            currentTask = { text: line.slice(6), done: line.startsWith('- [x]') }
            return
          }
          if (line.startsWith('  reminder: ') && currentTask) {
            const isoString = line.slice(12).trim()
            const reminderTime = new Date(isoString)
            if (!isNaN(reminderTime)) {
              allReminders.push({
                taskText: currentTask.text,
                noteTitle, filename, mode, isoString,
                isPast: reminderTime < now,
                done: currentTask.done,
                isPhaseDeadline: false,
              })
            }
          }
        })
      })
    } catch(e) { console.error('[get-all-reminders] read failed:', e) }
  })
  allReminders.sort((a,b) => new Date(a.isoString) - new Date(b.isoString))
  event.reply('all-reminders', allReminders)
})

// Toggle a task or phase-task done marker by rewriting the source file.
// Broadcasts 'reminders-changed' + 'external-task-toggled' so any open
// window refreshes. Invoked from reminders.html when the user clicks a
// reminder checkbox.
ipcMain.on('reminder-toggle', (event, req) => {
  if (!req || !req.filename || !req.mode) return
  const dir = req.mode === 'plan' ? PLAN_DIR
            : req.mode === 'longform' ? path.join(NOTES_DIR, 'longform')
            : req.mode === 'project'  ? path.join(NOTES_DIR, 'projects')
            : WRITE_DIR
  const filepath = path.join(dir, req.filename)
  if (!isInStaveNotesDir(filepath)) {
    console.error('[reminder-toggle] REFUSED foreign filepath:', filepath)
    return
  }

  let raw
  try { raw = fs.readFileSync(filepath, 'utf8') }
  catch(e) { console.error('[reminder-toggle] read failed:', e); return }

  const lines = raw.split('\n')
  const targetText = (req.taskText || '').trim()
  const targetIso  = (req.isoString || '').trim()
  const mark = req.newDone ? 'x' : ' '
  let mutated = false

  if (req.isPhaseDeadline) {
    // Phase deadline — add or remove a `status: done` line under the phase.
    // The phase is the ### heading whose name equals targetText and whose
    // deadline matches targetIso (YYYY-MM-DD prefix of the ISO).
    const deadlineDate = targetIso.slice(0, 10)
    let inPhase = false
    let phaseDeadlineMatched = false
    let phaseStartLine = -1
    let phaseEndLine = lines.length
    for (let i = 0; i < lines.length; i++) {
      if (lines[i] === '## phases') { inPhase = true; continue }
      if (lines[i].startsWith('## ') && lines[i] !== '## phases') { inPhase = false; continue }
      if (!inPhase) continue
      if (lines[i].startsWith('### ')) {
        if (phaseStartLine >= 0 && phaseDeadlineMatched) { phaseEndLine = i; break }
        phaseStartLine = lines[i].slice(4).trim() === targetText ? i : -1
        phaseDeadlineMatched = false
        continue
      }
      if (phaseStartLine >= 0 && lines[i].startsWith('deadline: ') && lines[i].slice(10).trim() === deadlineDate) {
        phaseDeadlineMatched = true
      }
    }
    if (phaseStartLine >= 0 && phaseDeadlineMatched) {
      // Look for an existing `status:` line between phaseStartLine and phaseEndLine
      let statusIdx = -1
      for (let i = phaseStartLine + 1; i < phaseEndLine; i++) {
        if (lines[i].startsWith('status: ')) { statusIdx = i; break }
        if (lines[i].startsWith('### ')) break
      }
      if (req.newDone) {
        if (statusIdx >= 0) lines[statusIdx] = 'status: done'
        else lines.splice(phaseStartLine + 1, 0, 'status: done')
      } else if (statusIdx >= 0) {
        lines.splice(statusIdx, 1)
      }
      mutated = true
    }
  } else {
    // Per-task reminder — match on the task text + the following reminder line
    for (let i = 0; i < lines.length - 1; i++) {
      const m = lines[i].match(/^(- \[)([x ])(\] )(.+)$/)
      if (!m) continue
      const taskBody = m[4].trim()
      if (taskBody !== targetText) continue
      // Check if next non-blank line is a matching reminder
      const next = lines[i+1]
      if (next && next.startsWith('  reminder: ') && next.slice(12).trim() === targetIso) {
        lines[i] = `${m[1]}${mark}${m[3]}${m[4]}`
        mutated = true
        break
      }
    }
  }

  if (!mutated) {
    console.warn('[reminder-toggle] no matching line found for', req)
    return
  }
  try { fs.writeFileSync(filepath, lines.join('\n'), 'utf8') }
  catch(e) { console.error('[reminder-toggle] write failed:', e); return }

  // Refresh reminders window and notify main window if the note is open
  if (remindersWin && !remindersWin.isDestroyed()) {
    remindersWin.webContents.send('reminders-changed')
  }
  if (win && !win.isDestroyed()) {
    win.webContents.send('external-task-toggled', {
      filename: req.filename, mode: req.mode,
    })
  }
})

ipcMain.on('reschedule-reminders', (event, reminders) => {
  const now = new Date()
  reminders.forEach(({ title, isoString }) => {
    const reminderTime = new Date(isoString)
    const delay = reminderTime - now
    if (delay > 0) {
      setTimeout(() => {
        if (Notification.isSupported()) {
          new Notification({ title: 'S†AVE', body: title, silent: false }).show()
        }
      }, delay)
    }
  })
})

ipcMain.on('set-win-mode', (event, mode) => {
  winMode = mode
  savePrefs({ ...loadPrefs(), winMode: mode })
  if (mode === 'float') {
    win.setAlwaysOnTop(true); win.setSkipTaskbar(true); win.show()
  } else if (mode === 'free') {
    win.setAlwaysOnTop(false); win.setSkipTaskbar(false); win.show()
  } else {
    win.setAlwaysOnTop(false); win.setSkipTaskbar(true)
  }
})

ipcMain.on('schedule-reminder', (event, { title, date, time }) => {
  const reminderTime = new Date(`${date}T${time}`)
  const delay = reminderTime - new Date()
  if (delay > 0) {
    setTimeout(() => {
      if (Notification.isSupported()) {
        new Notification({ title: 'S†AVE', body: title, silent: false }).show()
      }
    }, delay)
    event.reply('reminder-set', { ok: true, date, time })
  } else {
    event.reply('reminder-set', { ok: false, reason: 'Time is in the past' })
  }
})

ipcMain.on('export-pdf', (event, { html, title }) => {
  const { dialog, BrowserWindow: BW } = require('electron')
  const tmp = path.join(os.tmpdir(), 'stave-export.html')
  fs.writeFileSync(tmp, html, 'utf8')
  const printWin = new BW({ show: false })
  printWin.loadFile(tmp)
  printWin.once('ready-to-show', () => {
    dialog.showSaveDialog({
      defaultPath: `${title}.pdf`,
      filters: [{ name: 'PDF', extensions: ['pdf'] }]
    }).then(result => {
      if (!result.canceled) {
        printWin.webContents.printToPDF({}).then(data => {
          fs.writeFileSync(result.filePath, data)
          printWin.close()
        })
      } else { printWin.close() }
    })
  })
})
// ── CONTEXT MENU ──
app.on('web-contents-created', (event, contents) => {
  contents.on('context-menu', (e, params) => {
    const menu = new Menu()

    if (params.misspelledWord) {
      const suggestions = speller ? speller.suggest(params.misspelledWord).slice(0, 5) : []
      if (suggestions.length) {
        suggestions.forEach(word => {
          menu.append(new MenuItem({ label: word, click: () => contents.replaceMisspelling(word) }))
        })
        menu.append(new MenuItem({ type: 'separator' }))
      }
      menu.append(new MenuItem({
        label: 'Add to dictionary',
        click: () => contents.session.addWordToSpellCheckerDictionary(params.misspelledWord)
      }))
      menu.append(new MenuItem({ type: 'separator' }))
    }

    if (params.isEditable) {
      menu.append(new MenuItem({ role: 'cut' }))
      menu.append(new MenuItem({ role: 'copy' }))
      menu.append(new MenuItem({ role: 'paste' }))
    } else if (params.selectionText) {
      menu.append(new MenuItem({ role: 'copy' }))
    }

    if (menu.items.length > 0) menu.popup()
  })
})

let pendingFilePath = null
app.on('open-file', (event, filePath) => {
  event.preventDefault()
  if (!filePath.endsWith('.md')) return
  if (win && !win.isDestroyed()) {
    win.show()
    win.focus()
    win.webContents.send('open-file-path', filePath)
  } else {
    pendingFilePath = filePath
  }
})

app.whenReady().then(() => {
  if (process.platform === 'win32') {
    app.setAppUserModelId('com.codyvanscyoc.stave')
    const filePath = process.argv.find(arg => arg.endsWith('.md') && fs.existsSync(arg))
    if (filePath) pendingFilePath = filePath
  }
  ensureDirs()
  createTray()
  createWindow()
 globalShortcut.register('CommandOrControl+Shift+Space', () => {
    if (win.isVisible()) { if (winMode === 'hide') win.hide() }
    else { positionWindow(); win.show(); win.focus() }
  })

  globalShortcut.register('CommandOrControl+Shift+S', () => {
    const cursor = screen.getCursorScreenPoint()
    const display = screen.getDisplayNearestPoint(cursor)
    const { workArea } = display

    ;[win, searchWin, remindersWin, lockInWin, lockInPlanWin].forEach((w) => {
      if (w && !w.isDestroyed() && w.isVisible()) {
        const bounds = w.getBounds()
        w.setPosition(
          Math.min(workArea.x + workArea.width - bounds.width - 10,
            Math.max(workArea.x, bounds.x)),
          Math.min(workArea.y + workArea.height - bounds.height - 10,
            Math.max(workArea.y, bounds.y))
        )
      }
    })

    if (win && !win.isDestroyed()) {
      positionWindow()
      win.show()
      win.focus()
    }
  })

  if (app.dock) app.dock.hide()
})

app.on('window-all-closed', e => e.preventDefault())
app.on('will-quit', () => globalShortcut.unregisterAll())