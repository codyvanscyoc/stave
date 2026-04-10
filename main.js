const { app, BrowserWindow, Tray, Menu, MenuItem, globalShortcut, nativeImage, screen, ipcMain, Notification } = require('electron')
const path = require('path')
const fs = require('fs')
const os = require('os')

let tray = null
let win = null
let searchWin = null
let remindersWin = null
let winMode = 'hide'

const NOTES_DIR = path.join(os.homedir(), 'Library', 'Mobile Documents', 'com~apple~CloudDocs', 'Stave')
const WRITE_DIR = path.join(NOTES_DIR, 'write')
const PLAN_DIR  = path.join(NOTES_DIR, 'plan')
const PREFS_FILE = path.join(NOTES_DIR, 'prefs.json')

const DEFAULT_PREFS = { width: 420, height: 750, posX: null, posY: null, winMode: 'hide' }

function loadPrefs() {
  try {
    if (fs.existsSync(PREFS_FILE))
      return { ...DEFAULT_PREFS, ...JSON.parse(fs.readFileSync(PREFS_FILE, 'utf8')) }
  } catch(e) {}
  return { ...DEFAULT_PREFS }
}

function savePrefs(data) {
  try { fs.writeFileSync(PREFS_FILE, JSON.stringify(data, null, 2), 'utf8') } catch(e) {}
}

function ensureDirs() {
  const LONGFORM_DIR = path.join(NOTES_DIR, 'longform')
  const PROJECTS_DIR = path.join(NOTES_DIR, 'projects')
  ;[NOTES_DIR, WRITE_DIR, PLAN_DIR, LONGFORM_DIR, PROJECTS_DIR].forEach(d => {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true })
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
  const icon = nativeImage.createEmpty()
  tray = new Tray(icon)
  tray.setTitle('S†')
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
  if (win.isVisible()) {
    if (winMode === 'hide') win.hide()
    else {
      positionWindow()
      win.focus()
    }
  } else {
    positionWindow()
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
  try { fs.writeFileSync(filepath, content, 'utf8') } catch(e) {}
})

ipcMain.on('open-project-folder', (event, folderPath) => {
  require('electron').shell.openPath(folderPath)
})

ipcMain.on('get-all-projects', (event) => {
  const projectsDir = path.join(
    os.homedir(), 'Library', 'Mobile Documents',
    'com~apple~CloudDocs', 'Stave', 'projects'
  )
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

ipcMain.on('lockin-save', (event, { filepath, content }) => {
  try { fs.writeFileSync(filepath, content, 'utf8') } catch(e) {}
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
        let currentTask = null
        let inPhases = false
        let currentPhase = null
        lines.forEach(line => {
          if (line === '## phases') { inPhases = true; return }
          if (line.startsWith('## ') && line !== '## phases') { inPhases = false; currentPhase = null }

          if (inPhases && line.startsWith('### ')) {
            currentPhase = line.slice(4).trim()
          }
          if (inPhases && currentPhase && line.startsWith('deadline: ')) {
            const dateStr = line.slice(10).trim()
            const isoString = dateStr + 'T23:59:00'
            const deadlineTime = new Date(isoString)
            if (!isNaN(deadlineTime)) {
              allReminders.push({
                taskText: currentPhase,
                noteTitle, filename, mode, isoString,
                isPast: deadlineTime < now,
                done: false,
                isPhaseDeadline: true
              })
            }
          }

          if (line.startsWith('- [ ] ') || line.startsWith('- [x] ')) {
            currentTask = { text: line.slice(6), done: line.startsWith('- [x]') }
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
                isPhaseDeadline: false
              })
            }
          }
        })
      })
    } catch(e) {}
  })
  allReminders.sort((a,b) => new Date(a.isoString) - new Date(b.isoString))
  event.reply('all-reminders', allReminders)
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
      if (params.dictionaryWords && params.dictionaryWords.length) {
        params.dictionaryWords.slice(0, 5).forEach(word => {
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

  app.dock.hide()
})

app.on('window-all-closed', e => e.preventDefault())
app.on('will-quit', () => globalShortcut.unregisterAll())