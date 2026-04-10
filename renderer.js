'use strict'
const fs = require('fs')
const path = require('path')
const os = require('os')
const { ipcRenderer } = require('electron')

// ── PATHS ──
const NOTES_DIR    = path.join(os.homedir(), 'Library', 'Mobile Documents', 'com~apple~CloudDocs', 'Stave')
const WRITE_DIR    = path.join(NOTES_DIR, 'write')
const PLAN_DIR     = path.join(NOTES_DIR, 'plan')
const LONGFORM_DIR = path.join(NOTES_DIR, 'longform')
const PROJECTS_DIR = path.join(NOTES_DIR, 'projects')
const BIBLE_INDEX_PATH  = path.join(__dirname, 'bible-index.json')
const RECORDINGS_DIR    = path.join(NOTES_DIR, 'recordings')
const RECORDING_COLORS  = ['#c8922a', '#4caf7d', '#7f77dd', '#378add']

// ── STATE ──
let tabs           = []
let currentTabIndex = 0
let newTabMode     = 'write'
let saveTimer      = null
let isSwitching    = false
let winModeState   = 'hide'
let currentReminderRow = null
let cmuDict        = null
let wn             = null
let bibleIndex     = null
let currentDrawerWord = ''
let currentSource  = 'general'
let fmtModes       = {}
let recordingsOpen     = false
let activeRecorder     = null
let activeRecorderIndex = -1
let recordingStartTime = null
let recordingTimerInterval = null
let currentPlayingIndex = -1
let currentAudio = null
let lastWriteTabIndex = -1
let lastPlanTabIndex  = -1

// ════════════════════════════════════════
// LIBRARIES
// ════════════════════════════════════════

function loadCMU() {
  try {
    const { CMUDict } = require('cmudict')
    const dict = new CMUDict()
    dict.get('THE') // trigger full cache load
    cmuDict = dict
  } catch(e) { cmuDict = null }
}

function loadWordNet() {
  try { const natural = require('natural'); wn = new natural.WordNet() }
  catch(e) { wn = null }
}

function loadBibleIndex() {
  try {
    if (fs.existsSync(BIBLE_INDEX_PATH))
      bibleIndex = JSON.parse(fs.readFileSync(BIBLE_INDEX_PATH, 'utf8'))
  } catch(e) { bibleIndex = null }
}

// ════════════════════════════════════════
// PHONETICS & RHYMES
// ════════════════════════════════════════

function getPhones(word) {
  if (!cmuDict) return null
  const entry = cmuDict.get(word.toUpperCase())
  if (!entry) return null
  return entry.split(' ')
}

function getRhymeSignature(word) {
  const phones = getPhones(word)
  if (!phones) return null
  const idx = phones.findIndex(p => /[12]$/.test(p))
  return idx === -1 ? phones.slice(-2).join('-') : phones.slice(idx).join('-')
}

function getVowelSound(word) {
  const phones = getPhones(word)
  if (!phones) return null
  const v = phones.find(p => /[12]$/.test(p))
  return v ? v.replace(/[012]/,'') : null
}

function getEndingConsonants(word) {
  const phones = getPhones(word)
  if (!phones) return null
  const lastStress = phones.reduce((acc,p,i) => /[012]$/.test(p) ? i : acc, -1)
  if (lastStress === -1) return null
  const ending = phones.slice(lastStress+1)
  return ending.length > 0 ? ending.join('-') : null
}

function findRhymes(word) {
  if (!cmuDict || !cmuDict._cache) return { perfect: [], near: [] }
  const sig    = getRhymeSignature(word)
  const vowel  = getVowelSound(word)
  const cons   = getEndingConsonants(word)
  const wordUp = word.toUpperCase()
  const perfect = [], near = []

  Object.keys(cmuDict._cache).forEach(key => {
    if (key === wordUp) return
    const candidate = key.toLowerCase()
    if (!/^[a-z]+$/.test(candidate)) return
    if (sig) {
      const candSig = getRhymeSignature(candidate)
      if (candSig === sig) { if (perfect.length < 16) perfect.push(candidate); return }
    }
    if (near.length >= 16) return
    if (vowel) {
      const candVowel = getVowelSound(candidate)
      if (candVowel === vowel) { near.push(candidate); return }
    }
    if (cons) {
      const candCons = getEndingConsonants(candidate)
      if (candCons && candCons === cons) near.push(candidate)
    }
  })
  return { perfect: perfect.slice(0,14), near: near.slice(0,14) }
}

function countSyllables(word) {
  const phones = getPhones(word)
  if (phones) return Math.max(1, phones.filter(p => /[012]$/.test(p)).length)
  const w = word.toLowerCase().replace(/[^a-z]/g,'')
  if (!w.length) return 0
  if (w.length <= 2) return 1
  let count = 0, prev = false
  for (let i = 0; i < w.length; i++) {
    const isV = 'aeiouy'.includes(w[i])
    if (isV && !prev) count++
    prev = isV
  }
  if (w.endsWith('e') && count > 1) count--
  return Math.max(1, count)
}

function countLineSyllables(line) {
  return line.trim().split(/\s+/)
    .filter(w => w.replace(/[^a-z]/gi,'').length > 0)
    .reduce((s, w) => s + countSyllables(w.replace(/[^a-z]/gi,'')), 0)
}

// ════════════════════════════════════════
// WORDNET SYNONYMS
// ════════════════════════════════════════

const CLEAN_WORD = /^[a-z][a-z\s]{0,20}$/
const BLOCK = new Set(['fuck','shit','ass','damn','hell','sex','sexy','crap','piss',
  'cock','dick','bitch','bastard','whore','slut','nude','naked','erotic','explicit',
  'screw','bang','hump','bonk','shag'])

function getSynonyms(word) {
  return new Promise(resolve => {
    if (!wn) { resolve([]); return }
    wn.lookup(word, results => {
      if (!results || !results.length) { resolve([]); return }
      const syns = new Set()
      results.forEach(result => {
        if (!result.synonyms) return
        result.synonyms.forEach(s => {
          const clean = s.replace(/_/g,' ').toLowerCase().trim()
          if (clean === word.toLowerCase()) return
          if (!CLEAN_WORD.test(clean)) return
          if (BLOCK.has(clean)) return
          if (clean.split(' ').some(w => BLOCK.has(w))) return
          syns.add(clean)
        })
      })
      resolve([...syns].slice(0, 20))
    })
  })
}

// ════════════════════════════════════════
// SONGS DICTIONARY
// ════════════════════════════════════════

const SONGS_WORDS = {
  faithful: {
    label: 'faithful / steadfast',
    synonyms: ['steadfast','unwavering','sure','constant','loyal','trustworthy','firm','reliable','immovable','enduring','abiding','unshaken','resolute','true'],
    expand: ['covenant','oath','promise','vow','bond','pledge','word','anchor']
  },
  mercy: {
    label: 'mercy / grace',
    synonyms: ['grace','compassion','kindness','tender','pardon','favor','pity','forbearance','clemency','charity','benevolence','lovingkindness'],
    expand: ['undeserved','lavish','poured','overflowing','sufficient','covering','abundant','rich','deep','wide','boundless']
  },
  redemption: {
    label: 'redemption / salvation',
    synonyms: ['rescue','ransom','liberate','deliver','reclaim','restore','recover','atone','reconcile','justify','acquit','vindicate'],
    expand: ['bought','purchased','freed','loosed','unbound','released','pardoned','cleansed','washed','healed']
  },
  surrender: {
    label: 'surrender / yield',
    synonyms: ['yield','release','relinquish','offer','consecrate','devote','dedicate','present','give','lay down','open','abandon','entrust'],
    expand: ['undone','broken','emptied','poured out','undefended','vulnerable','open handed','released']
  },
  weakness: {
    label: 'weakness / humility',
    synonyms: ['frail','fragile','faint','spent','empty','hollow','bare','stripped','undone','lowly','meek','contrite','humble','needy'],
    expand: ['insufficient','unable','dependent','helpless','desperate','longing','reaching','thirsting']
  },
  presence: {
    label: 'presence / dwelling',
    synonyms: ['dwell','abide','remain','inhabit','rest','settle','hover','fill','flood','permeate','surround','envelop','cover','overshadow'],
    expand: ['nearness','closeness','shelter','refuge','home','sanctuary','haven','hiding place']
  },
  peace: {
    label: 'peace / rest',
    synonyms: ['stillness','quiet','calm','settle','hush','cease','breathe','release','relent','soften','ease','solace','comfort','tranquil'],
    expand: ['undisturbed','untroubled','steadied','grounded','held','kept','secured','anchored']
  },
  light: {
    label: 'light / hope',
    synonyms: ['dawn','break','rise','shine','glow','radiate','illuminate','flood','pour','spill','burn','blaze','kindle','spark'],
    expand: ['morning','daybreak','sunrise','first light','horizon','threshold','emerging','awakening']
  },
  darkness: {
    label: 'darkness / struggle',
    synonyms: ['shadow','night','void','hollow','barren','dry','fallow','withered','heavy','burdened','weighted','pressed','crushed','worn'],
    expand: ['wilderness','desert','valley','depth','low','beneath','under','sinking','drowning','gasping']
  },
  praise: {
    label: 'praise / worship',
    synonyms: ['exalt','magnify','honor','glorify','bless','adore','revere','extol','celebrate','declare','proclaim','lift','raise','crown'],
    expand: ['resound','ring out','echo','overflow','burst','erupt','pour forth','cannot contain']
  },
  cross: {
    label: 'cross / atonement',
    synonyms: ['sacrifice','offering','substitute','exchange','payment','ransom','propitiation','expiation','blood','wounds','stripes','suffering'],
    expand: ['in my place','for my shame','bearing','carrying','taking','receiving','enduring','absorbing']
  },
  longing: {
    label: 'longing / seeking',
    synonyms: ['hunger','thirst','ache','yearn','search','pursue','chase','run','draw near','reach','stretch','strain','cry','call'],
    expand: ['desperate','undone','undying','consuming','relentless','unceasing','insatiable','burning']
  },
  freedom: {
    label: 'freedom / new life',
    synonyms: ['unbound','loosed','released','unchained','untangled','liberated','emancipated','restored','renewed','alive','awakened','risen'],
    expand: ['no longer','once was','now I am','chains broken','stone rolled','veil torn','war over']
  },
  waiting: {
    label: 'waiting / trust',
    synonyms: ['tarry','linger','remain','stay','hold','rest','lean','depend','trust','hope','expect','watch','endure','persevere'],
    expand: ['patient','still','quiet','unhurried','unrushed','in season','not yet','even so','nevertheless']
  }
}

// ════════════════════════════════════════
// WORD PALETTE (general poetic fallback)
// ════════════════════════════════════════

const WORD_PALETTE = [
  { label: 'motion',  words: ['rise','fall','run','carry','pull','break','bend','lift','shake','still','turn','move','drift','scatter','gather','cross','climb','descend','return','flee'] },
  { label: 'light',   words: ['dawn','glow','flicker','blaze','burn','shine','fade','ember','spark','flame','beam','gleam','dark','dim','shadow','bright','golden','pale','radiant','soft'] },
  { label: 'nature',  words: ['stone','water','fire','wind','earth','seed','root','branch','river','ocean','mountain','valley','sky','soil','dust','rain','flood','drought','wild','deep'] },
  { label: 'body',    words: ['hands','heart','voice','breath','eyes','bones','chest','knees','lips','skin','tears','feet','arms','blood','spine','face','throat','frame','pulse','ache'] },
  { label: 'time',    words: ['moment','forever','ancient','before','after','always','never','once','now','long','again','soon','old','new','gone','remain','waiting','coming','past','end'] },
  { label: 'sound',   words: ['whisper','cry','silence','echo','ring','hush','call','shout','sing','speak','roar','groan','moan','sigh','resound','quiet','loud','still','song','word'] },
  { label: 'emotion', words: ['ache','wonder','grief','joy','longing','fear','hope','dread','awe','rage','peace','hunger','thirst','love','loss','shame','pride','doubt','trust','rest'] },
  { label: 'place',   words: ['home','wilderness','threshold','crossing','refuge','exile','shelter','road','gate','door','field','shore','edge','center','void','ground','hidden','open','far','near'] }
]

function findWordWebMatches(word) {
  const w = word.toLowerCase()
  const matches = []
  Object.values(SONGS_WORDS).forEach(group => {
    const inSyns   = group.synonyms.some(s => s.toLowerCase() === w)
    const inExpand = group.expand.some(s => s.toLowerCase() === w)
    const inLabel  = group.label.toLowerCase().split(/[\s\/]+/).some(t => t === w)
    if (inSyns || inExpand || inLabel) matches.push(group)
  })
  return matches
}

function getPaletteCategories(word) {
  // deterministic 3-category selection based on word so it doesn't shuffle each call
  const hash = word.split('').reduce((a, c) => a + c.charCodeAt(0), 0)
  const picks = []
  for (let i = 0; i < 3; i++) picks.push(WORD_PALETTE[(hash + i * 3) % WORD_PALETTE.length])
  return picks
}

// ════════════════════════════════════════
// TAB DATA MODEL
// ════════════════════════════════════════

function emptyTab(mode) {
  return {
    filename: null, filepath: null,
    mode: mode || newTabMode,
    title: '', idea: '', context: '', tags: [],
    planContext: '', admin: '', tasks: [],
    phases: [], links: [], recordings: []
  }
}

function getDirForMode(mode) {
  if (mode === 'plan') return PLAN_DIR
  return WRITE_DIR
}

function getColorForMode(mode) {
  if (mode === 'plan') return '#4caf7d'
  return '#c8922a'
}

// ════════════════════════════════════════
// SERIALIZE / PARSE
// ════════════════════════════════════════

function serializeTab(tab) {
  if (tab.mode === 'write' || tab.mode === 'longform') {
    const recs = (tab.recordings || []).filter(Boolean)
    return [
      `# ${tab.title || 'untitled'}`,
      `type: ${tab.mode}`,
      `tags: ${(tab.tags||[]).join(', ')}`,
      ...(recs.length ? [`recordings: ${recs.join(', ')}`] : []),
      '',
      '## idea',
      tab.idea || '',
      '',
      '## context',
      tab.context || '',
      ''
    ].join('\n')
  } else {
    let md = [
      `# ${tab.title || 'untitled'}`,
      `type: plan`,
      `context1: ${tab.planContext || ''}`,
      '',
      '## admin',
      tab.admin || '',
      '',
      '## tasks'
    ].join('\n') + '\n'

    ;(tab.tasks || []).forEach(t => {
      md += `- [${t.done ? 'x' : ' '}] ${t.text}\n`
      if (t.reminder) md += `  reminder: ${t.reminder}\n`
    })

    md += '\n## phases\n'
    ;(tab.phases || []).forEach(phase => {
      md += `### ${phase.name}\n`
      if (phase.start)    md += `start: ${phase.start}\n`
      if (phase.deadline) md += `deadline: ${phase.deadline}\n`
      ;(phase.tasks || []).forEach(t => {
        md += `- [${t.done ? 'x' : ' '}] ${t.text}\n`
      })
    })

    md += '\n## links\n'
    ;(tab.links || []).forEach(l => { md += `- ${l}\n` })

    return md
  }
}

function parseNote(raw, mode) {
  const lines = raw.split('\n')
  let title = '', idea = '', context = '', admin = '', planContext = ''
  let tags = [], tasks = [], phases = [], links = [], recordings = []
  let section = '', currentPhase = null

  lines.forEach(line => {
    if (line.startsWith('# '))           { title = line.slice(2).trim(); return }
    if (line.startsWith('type: '))       { return }
    if (line.startsWith('tags: '))       { tags = line.slice(6).split(',').map(t=>t.trim()).filter(Boolean); return }
    if (line.startsWith('recordings: ')) { recordings = line.slice(12).split(',').map(r=>r.trim()).filter(Boolean); return }
    if (line.startsWith('context1: '))   { planContext = line.slice(10); return }
    if (line === '## idea')              { section = 'idea'; return }
    if (line === '## context')           { section = 'context'; return }
    if (line === '## admin')             { section = 'admin'; return }
    if (line === '## tasks')             { section = 'tasks'; return }
    if (line === '## phases')            { section = 'phases'; return }
    if (line === '## links')             { section = 'links'; return }

    if (section === 'idea')    { idea    += (idea    ? '\n' : '') + line; return }
    if (section === 'context') { context += (context ? '\n' : '') + line; return }
    if (section === 'admin')   { admin   += (admin   ? '\n' : '') + line; return }

    if (section === 'tasks') {
      if (line.startsWith('- [x] '))      tasks.push({ text: line.slice(6).trim(), done: true,  reminder: null })
      else if (line.startsWith('- [ ] ')) tasks.push({ text: line.slice(6).trim(), done: false, reminder: null })
      else if (line.startsWith('  reminder: ') && tasks.length > 0)
        tasks[tasks.length-1].reminder = line.slice(12).trim()
      return
    }

    if (section === 'phases') {
      if (line.startsWith('### ')) {
        currentPhase = { name: line.slice(4).trim(), start: null, deadline: null, tasks: [] }
        phases.push(currentPhase)
      } else if (line.startsWith('start: ') && currentPhase) {
        currentPhase.start = line.slice(7).trim()
      } else if (line.startsWith('deadline: ') && currentPhase) {
        currentPhase.deadline = line.slice(10).trim()
      } else if ((line.startsWith('- [ ] ') || line.startsWith('- [x] ')) && currentPhase) {
        currentPhase.tasks.push({ text: line.slice(6).trim(), done: line.startsWith('- [x]') })
      }
      return
    }

    if (section === 'links') {
      if (line.startsWith('- ')) links.push(line.slice(2).trim())
      return
    }
  })

  return {
    title,
    idea:        idea.trim(),
    context:     context.trim(),
    admin:       admin.trim(),
    planContext,
    tags,
    tasks,
    phases,
    links,
    recordings
  }
}

// ════════════════════════════════════════
// FILE I/O
// ════════════════════════════════════════

function ensureDirs() {
  [NOTES_DIR, WRITE_DIR, PLAN_DIR, LONGFORM_DIR, PROJECTS_DIR, RECORDINGS_DIR].forEach(d => {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true })
  })
}

function getNotesList(mode) {
  const dir = getDirForMode(mode)
  try {
    return fs.readdirSync(dir)
      .filter(f => f.endsWith('.md'))
      .sort((a,b) => {
        const sa = fs.statSync(path.join(dir,a)).mtime
        const sb = fs.statSync(path.join(dir,b)).mtime
        return sb - sa
      })
  } catch(e) { return [] }
}

function loadNoteAsTab(filename, mode) {
  const dir = getDirForMode(mode)
  const filepath = path.join(dir, filename)
  if (!fs.existsSync(filepath)) return null
  const raw = fs.readFileSync(filepath, 'utf8')
  const tab = emptyTab(mode)
  tab.filename = filename
  tab.filepath = filepath
  Object.assign(tab, parseNote(raw, mode))
  return tab
}

function writeTabToDisk(tab) {
  if (!tab || !tab.filepath) return
  try { fs.writeFileSync(tab.filepath, serializeTab(tab), 'utf8') } catch(e) {}
}

function formatDateTitle(d) {
  const days   = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat']
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
  return `${days[d.getDay()]} ${months[d.getMonth()]} ${d.getDate()}`
}

function formatMeta(filepath) {
  try {
    const d = new Date(fs.statSync(filepath).mtime)
    return `saved ${(d.getMonth()+1).toString().padStart(2,'0')}/${d.getDate().toString().padStart(2,'0')}/${d.getFullYear().toString().slice(2)} ${d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}`
  } catch(e) { return '' }
}

function createNoteFile(tab, callback) {
  const dir = getDirForMode(tab.mode)
  const now = new Date()
  const stamp = now.toISOString().slice(0,16).replace('T','_').replace(':','-')
  const filename = `${stamp}.md`
  const filepath = path.join(dir, filename)
  tab.filename = filename
  tab.filepath = filepath
  if (!tab.title) tab.title = formatDateTitle(now)

  if (tab.mode === 'longform') {
    chooseLongformTemplate(key => {
      const tmpl = getTemplateContent(key)
      if (tmpl.title) tab.title = tmpl.title
      tab.idea = tmpl.content
      writeTabToDisk(tab)
      if (callback) callback()
    })
  } else {
    writeTabToDisk(tab)
    if (callback) callback()
  }
}

// ════════════════════════════════════════
// PREFS
// ════════════════════════════════════════

function saveTabPrefs() {
  try {
    const prefs = loadPrefs()
    prefs.tabs = tabs.map(t => ({ filename: t.filename, mode: t.mode, filepath: t.filepath }))
    prefs.currentTabIndex = currentTabIndex
    prefs.winMode = winModeState
    fs.writeFileSync(path.join(NOTES_DIR, 'prefs.json'), JSON.stringify(prefs, null, 2), 'utf8')
  } catch(e) {}
}

function loadPrefs() {
  try {
    const p = path.join(NOTES_DIR, 'prefs.json')
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch(e) {}
  return {}
}

// ════════════════════════════════════════
// CORE SAVE SYSTEM — SOURCE OF TRUTH IS tabs[]
// ════════════════════════════════════════

// Called on every keystroke — syncs DOM → tab object immediately
// The tab object is ALWAYS up to date
function syncTabFromDOM() {
  if (isSwitching) return
  const tab = tabs[currentTabIndex]
  if (!tab) return

  tab.title = document.getElementById('note-title').value || ''

  if (tab.mode === 'write' || tab.mode === 'longform') {
    tab.idea    = document.getElementById('idea-area').value
    tab.context = document.getElementById('context-area').value
    tab.tags    = currentTags()
  } else {
    tab.planContext = document.getElementById('plan-context-input').value
    tab.admin       = document.getElementById('admin-area').value
    tab.tasks       = getTasksFromDOM()
    // phases and links are NOT in the normal DOM — they live in Lock In plan
    // preserve whatever is already in tab.phases and tab.links
  }
}

// Write current tab to disk — reads from tab object, never DOM
function saveCurrentTab() {
  const tab = tabs[currentTabIndex]
  if (!tab || !tab.filepath) return
  writeTabToDisk(tab)
}

// Autosave — syncs DOM to tab object then schedules disk write
function autoSave() {
  if (isSwitching) return
  syncTabFromDOM()
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    if (isSwitching) return
    saveCurrentTab()
    const tab = tabs[currentTabIndex]
    if (tab?.filepath) {
      document.getElementById('note-meta').textContent = formatMeta(tab.filepath)
    }
    renderTabBar()
  }, 800)
}

// ════════════════════════════════════════
// TAB SWITCHING — SAFE
// ════════════════════════════════════════

function switchTab(index) {
  if (index === currentTabIndex && tabs[index]) return

  // Remember last active tab per mode
  const leaving = tabs[currentTabIndex]
  if (leaving?.mode === 'write' || leaving?.mode === 'longform') lastWriteTabIndex = currentTabIndex
  else if (leaving?.mode === 'plan') lastPlanTabIndex = currentTabIndex

  // Stop any active recording before switching
  if (activeRecorder && activeRecorder.state === 'recording') stopRecording()

  // 1. Stop autosave timer
  clearTimeout(saveTimer)
  isSwitching = true

  // 2. Sync current DOM state to current tab object
  syncTabFromDOM()

  // 3. Write current tab to disk immediately
  writeTabToDisk(tabs[currentTabIndex])

  // 4. Clear DOM to prevent stale content showing
  document.getElementById('note-title').value = ''
  document.getElementById('idea-area').value = ''
  document.getElementById('admin-area').value = ''
  document.getElementById('plan-context-input').value = ''
  document.getElementById('task-list').innerHTML = ''

  // 5. Switch index and load new tab
  currentTabIndex = index
  loadTabIntoDOM(tabs[currentTabIndex])
  renderTabBar()
  saveTabPrefs()

  // 6. Re-enable autosave after DOM is settled
  setTimeout(() => { isSwitching = false }, 300)
}

function loadTabIntoDOM(tab) {
  if (!tab) return
  document.getElementById('note-title').value = tab.title || ''
  document.getElementById('note-meta').textContent = tab.filepath ? formatMeta(tab.filepath) : ''

  const isWriteLike = tab.mode === 'write' || tab.mode === 'longform'
  document.getElementById('panel-write').classList.toggle('active', isWriteLike)
  document.getElementById('panel-plan').classList.toggle('active', !isWriteLike)
  document.getElementById('rec-toggle').style.display = isWriteLike ? '' : 'none'

  if (isWriteLike) {
    document.getElementById('idea-area').value = tab.idea || ''
    document.getElementById('context-area').value = tab.context || ''
    renderTagsFromArray(tab.tags || [])
    updateSyllableOverlay()
    if (recordingsOpen) renderRecordingsPanel()
    setTimeout(() => document.getElementById('idea-area').focus(), 50)
  } else {
    document.getElementById('plan-context-input').value = tab.planContext || ''
    document.getElementById('admin-area').value = tab.admin || ''
    renderTasks(tab.tasks || [])
    setTimeout(() => document.getElementById('admin-area').focus(), 50)
  }
}

// ════════════════════════════════════════
// TAB MANAGEMENT
// ════════════════════════════════════════

function newTab() {
  clearTimeout(saveTimer)
  isSwitching = true

  // sync and save current tab before creating new one
  syncTabFromDOM()
  writeTabToDisk(tabs[currentTabIndex])

  const tab = emptyTab(newTabMode)
  tabs.push(tab)
  currentTabIndex = tabs.length - 1

  createNoteFile(tab, () => {
    isSwitching = false
    loadTabIntoDOM(tab)
    renderTabBar()
    saveTabPrefs()
    document.getElementById('note-title').focus()
  })
}

function closeTab(index) {
  clearTimeout(saveTimer)
  syncTabFromDOM()
  writeTabToDisk(tabs[currentTabIndex])

  if (tabs.length === 1) {
    // don't close last tab — just clear it
    isSwitching = true
    const tab = emptyTab(newTabMode)
    createNoteFile(tab, () => {
      tabs[0] = tab
      currentTabIndex = 0
      isSwitching = false
      loadTabIntoDOM(tab)
      renderTabBar()
      saveTabPrefs()
    })
    return
  }

  tabs.splice(index, 1)
  if (currentTabIndex >= tabs.length) currentTabIndex = tabs.length - 1
  isSwitching = false
  loadTabIntoDOM(tabs[currentTabIndex])
  renderTabBar()
  saveTabPrefs()
}

function renderTabBar() {
  const bar    = document.getElementById('tab-bar')
  const addBtn = document.getElementById('tab-add')
  bar.querySelectorAll('.tab').forEach(t => t.remove())

  tabs.filter(tab => tab.mode === newTabMode).forEach(tab => {
    const realIndex = tabs.indexOf(tab)
    const el = document.createElement('div')
    el.className = 'tab' + (realIndex === currentTabIndex ? ' active' : '')

    const dot = document.createElement('div')
    dot.className = 'tab-dot'
    dot.style.background = getColorForMode(tab.mode)

    const title = document.createElement('div')
    title.className = 'tab-title'
    title.textContent = tab.title || 'untitled'

    const close = document.createElement('div')
    close.className = 'tab-close'
    close.textContent = '×'
    close.onclick = e => { e.stopPropagation(); closeTab(realIndex) }

    el.appendChild(dot); el.appendChild(title); el.appendChild(close)
    el.onclick = () => switchTab(realIndex)
    bar.insertBefore(el, addBtn)
  })

  // sync mode toggle to current tab
  const currentMode = tabs[currentTabIndex]?.mode || newTabMode
  ;['write','plan'].forEach(m => {
    const btn = document.getElementById('btn-' + m)
    if (btn) btn.classList.toggle('active', m === currentMode)
  })
}

function setNewTabMode(mode) {
  newTabMode = mode
  ;['write','plan'].forEach(m => {
    const btn = document.getElementById('btn-' + m)
    if (btn) btn.classList.toggle('active', m === mode)
  })

  // return to the last tab the user was on in this mode, if it still exists
  const lastIndex = mode === 'plan' ? lastPlanTabIndex : lastWriteTabIndex
  if (lastIndex !== -1 && tabs[lastIndex]?.mode === mode) {
    switchTab(lastIndex)
    return
  }
  // otherwise fall back to most recent tab of this mode
  const modeTabIndex = tabs.reduce((found, tab, i) => tab.mode === mode ? i : found, -1)
  if (modeTabIndex !== -1) switchTab(modeTabIndex)
  else renderTabBar()
}

// ════════════════════════════════════════
// TAGS
// ════════════════════════════════════════

let tags = []

function currentTags() {
  return Array.from(document.querySelectorAll('.tag'))
    .map(t => t.childNodes[0].textContent.trim())
    .filter(Boolean)
}

function showTagInput() {
  const input = document.getElementById('tag-input')
  input.style.display = 'block'; input.focus()
  input.onkeydown = e => {
    if (e.key === 'Enter') {
      const val = input.value.trim()
      if (val) { tags.push(val); renderTagsFromArray(tags); autoSave() }
      input.value = ''; input.style.display = 'none'
    }
    if (e.key === 'Escape') { input.value = ''; input.style.display = 'none' }
  }
}

function renderTagsFromArray(tagArray) {
  tags = tagArray || []
  const row   = document.getElementById('tags-row')
  const input = document.getElementById('tag-input')
  row.querySelectorAll('.tag').forEach(t => t.remove())
  tags.forEach(tag => {
    const chip = document.createElement('span')
    chip.className = 'tag'
    chip.innerHTML = `${tag}<span class="tag-x" title="remove">×</span>`
    chip.querySelector('.tag-x').onclick = e => {
      e.stopPropagation()
      tags = tags.filter(t => t !== tag)
      renderTagsFromArray(tags); autoSave()
    }
    row.insertBefore(chip, input)
  })
}

// ════════════════════════════════════════
// SYLLABLE OVERLAY
// ════════════════════════════════════════

function updateSyllableOverlay() { /* removed */ }

function getCurrentLine() {
  const area = document.getElementById('idea-area')
  const text  = area.value, pos = area.selectionStart
  const start = text.lastIndexOf('\n', pos-1) + 1
  const end   = text.indexOf('\n', pos)
  return end === -1 ? text.slice(start) : text.slice(start, end)
}

// ════════════════════════════════════════
// FORMATTING
// ════════════════════════════════════════

function fmtToggle(marker) {
  const area = document.getElementById('idea-area')
  const s = area.selectionStart, e = area.selectionEnd
  if (s !== e) {
    const selected = area.value.slice(s, e)
    const replacement = marker + selected + marker
    area.value = area.value.slice(0,s) + replacement + area.value.slice(e)
    area.selectionStart = s + marker.length
    area.selectionEnd   = s + marker.length + selected.length
    area.focus(); autoSave(); return
  }
  if (fmtModes[marker]) {
    const pos = area.selectionStart
    area.value = area.value.slice(0, pos) + marker + area.value.slice(pos)
    area.selectionStart = area.selectionEnd = pos + marker.length
    fmtModes[marker] = false
  } else {
    const pos = area.selectionStart
    area.value = area.value.slice(0, pos) + marker + area.value.slice(pos)
    area.selectionStart = area.selectionEnd = pos + marker.length
    fmtModes[marker] = true
  }
  area.focus(); autoSave()
}

function fmtWrap(before, after) {
  const area = document.getElementById('idea-area')
  const s = area.selectionStart, e = area.selectionEnd
  const selected = area.value.slice(s, e)
  const replacement = before + (selected || 'text') + after
  area.value = area.value.slice(0,s) + replacement + area.value.slice(e)
  area.selectionStart = s + before.length
  area.selectionEnd   = s + before.length + (selected || 'text').length
  area.focus(); autoSave()
}

function showMarkdownHint() { document.getElementById('markdown-hint').style.display = 'block' }
function hideMarkdownHint() { document.getElementById('markdown-hint').style.display = 'none' }

// ════════════════════════════════════════
// BULLET / LIST HANDLING
// ════════════════════════════════════════

function handleBullet(e) {
  if (e.key === 'Tab') {
    e.preventDefault()
    const area = e.target, pos = area.selectionStart
    const text = area.value
    const lineStart = text.lastIndexOf('\n', pos-1) + 1
    const lineEnd   = text.indexOf('\n', pos)
    const end       = lineEnd === -1 ? text.length : lineEnd
    const line      = text.slice(lineStart, end)

    if (e.shiftKey) {
      if (line.startsWith('    ')) {
        area.value = text.slice(0, lineStart) + line.slice(4) + text.slice(end)
        area.selectionStart = area.selectionEnd = Math.max(lineStart, pos - 4)
      }
    } else {
      area.value = text.slice(0, lineStart) + '    ' + line + text.slice(end)
      area.selectionStart = area.selectionEnd = pos + 4
    }
    autoSave(); return
  }

  if (e.key === 'Enter') {
    const area = e.target, pos = area.selectionStart
    const text = area.value
    const lineStart = text.lastIndexOf('\n', pos-1) + 1
    const line = text.slice(lineStart, pos)

    const bulletMatch = line.match(/^(\s*)(•)\s+/)
    if (bulletMatch) {
      e.preventDefault()
      if (line.trim() === '•') {
        area.value = text.slice(0, lineStart) + '\n' + text.slice(pos)
        area.selectionStart = area.selectionEnd = lineStart + 1
      } else {
        const insert = '\n' + bulletMatch[1] + '• '
        area.value = text.slice(0, pos) + insert + text.slice(pos)
        area.selectionStart = area.selectionEnd = pos + insert.length
      }
      autoSave(); return
    }

    const numMatch = line.match(/^(\s*)(\d+)\.\s+/)
    if (numMatch) {
      e.preventDefault()
      if (line.trim() === numMatch[2] + '.') {
        area.value = text.slice(0, lineStart) + '\n' + text.slice(pos)
        area.selectionStart = area.selectionEnd = lineStart + 1
      } else {
        const insert = '\n' + numMatch[1] + (parseInt(numMatch[2]) + 1) + '. '
        area.value = text.slice(0, pos) + insert + text.slice(pos)
        area.selectionStart = area.selectionEnd = pos + insert.length
      }
      autoSave(); return
    }

    const dashMatch = line.match(/^(\s*)-\s+/)
    if (dashMatch) {
      e.preventDefault()
      if (line.trim() === '-') {
        area.value = text.slice(0, lineStart) + '\n' + text.slice(pos)
        area.selectionStart = area.selectionEnd = lineStart + 1
      } else {
        const insert = '\n' + dashMatch[1] + '- '
        area.value = text.slice(0, pos) + insert + text.slice(pos)
        area.selectionStart = area.selectionEnd = pos + insert.length
      }
      autoSave(); return
    }
    return
  }

  if (e.key === ' ') {
    const area = e.target, pos = area.selectionStart
    const text = area.value
    const lineStart = text.lastIndexOf('\n', pos-1) + 1
    if (text.slice(lineStart, pos) === '-') {
      e.preventDefault()
      const bullet = '• '
      area.value = text.slice(0, lineStart) + bullet + text.slice(pos)
      area.selectionStart = area.selectionEnd = lineStart + bullet.length
      autoSave()
    }
  }

  if (e.key === 'Enter') {
    // ensure the new line is visible after any Enter keypress
    requestAnimationFrame(() => {
      const area = e.target
      const lineH = parseFloat(window.getComputedStyle(area).lineHeight) || 28
      const lines = area.value.substring(0, area.selectionStart).split('\n').length
      const cursorBottom = lines * lineH
      if (cursorBottom > area.scrollTop + area.clientHeight - lineH) {
        area.scrollTop = cursorBottom - area.clientHeight + lineH * 2
      }
    })
  }
}

// ════════════════════════════════════════
// SONGWRITER DRAWER
// ════════════════════════════════════════

function setSource(src) {
  currentSource = src
  ;['general','songs','scripture'].forEach(s => {
    document.getElementById('src-'+s).classList.toggle('active', s === src)
  })
  if (currentDrawerWord) renderDrawerContent(currentDrawerWord)
}

async function openDrawer(word) {
  const clean = word.replace(/[^a-z]/gi,'').toLowerCase()
  if (clean.length < 2) return

  currentDrawerWord = clean
  currentSource = 'general'
  ;['general','songs','scripture'].forEach(s => {
    document.getElementById('src-'+s).classList.toggle('active', s === 'general')
  })

  document.getElementById('drawer-word').textContent = clean
  const sylCount = countSyllables(clean)
  const lineSyls = countLineSyllables(getCurrentLine())
  document.getElementById('drawer-meta').textContent = `${sylCount} syl · line: ${lineSyls} syl`
  document.getElementById('tool-drawer').classList.add('open')
  document.getElementById('drawer-content').innerHTML = ''

  await renderDrawerContent(clean)
}

async function renderDrawerContent(word) {
  const container = document.getElementById('drawer-content')
  container.innerHTML = ''
  if (currentSource === 'general')    await renderGeneral(word, container)
  else if (currentSource === 'songs')      renderSongs(word, container)
  else if (currentSource === 'scripture')  renderScripture(word, container)
}

async function renderGeneral(word, container) {
  container.innerHTML = ''
  const wordSig = getRhymeSignature(word)
  const { perfect, near } = findRhymes(word)

  // ── rhymes ──
  const rhymeSection = document.createElement('div')
  rhymeSection.className = 'drawer-section'
  rhymeSection.innerHTML = `
    <div class="drawer-label">rhymes</div>
    <div class="rhyme-chips" id="rc-perfect"></div>`
  container.appendChild(rhymeSection)
  renderChips(document.getElementById('rc-perfect'), perfect, true)

  // ── synonyms (async) ──
  const synSection = document.createElement('div')
  synSection.className = 'drawer-section'
  synSection.innerHTML = '<div class="drawer-label">synonyms</div><div class="syn-chips" id="syn-chips"><span class="drawer-loading">looking up...</span></div>'
  container.appendChild(synSection)

  const syns = await getSynonyms(word)
  const synContainer = document.getElementById('syn-chips')
  if (!synContainer) return
  synContainer.innerHTML = ''

  if (!syns.length) {
    synContainer.innerHTML = '<span class="drawer-loading">none found</span>'
  } else {
    syns.forEach(syn => {
      const synWord = syn.split(' ')[0]
      const synSig  = getRhymeSignature(synWord)
      const rhymes  = wordSig && synSig && synSig === wordSig
      const chip = document.createElement('div')
      chip.className = 'syn-chip' + (rhymes ? ' rhymes' : '')
      if (rhymes) { const dot = document.createElement('span'); dot.className = 'rhyme-dot'; chip.appendChild(dot) }
      chip.appendChild(document.createTextNode(syn))
      chip.onclick = () => insertWord(syn)
      synContainer.appendChild(chip)
    })
  }

  // ── word web ──
  const webSection = document.createElement('div')
  webSection.className = 'drawer-section'
  const webLabel = document.createElement('div')
  webLabel.className = 'drawer-label'

  const songMatches = findWordWebMatches(word)
  const categories = songMatches.length ? songMatches : getPaletteCategories(word)
  const sourceNote = songMatches.length ? '' : ' — poetic palette'
  webLabel.textContent = 'word web' + sourceNote
  webSection.appendChild(webLabel)

  categories.forEach(group => {
    const groupLabel = document.createElement('div')
    groupLabel.className = 'rhyme-group-label'
    groupLabel.style.marginTop = '8px'
    groupLabel.textContent = group.label
    webSection.appendChild(groupLabel)

    const chips = document.createElement('div')
    chips.className = 'syn-chips'
    const wordList = group.words || [...(group.synonyms || []), ...(group.expand || [])]
    wordList.forEach(w => {
      const sig    = getRhymeSignature(w.split(' ')[0])
      const rhymes = wordSig && sig && sig === wordSig
      const chip   = document.createElement('div')
      chip.className = 'syn-chip' + (rhymes ? ' rhymes' : '')
      if (rhymes) { const dot = document.createElement('span'); dot.className = 'rhyme-dot'; chip.appendChild(dot) }
      chip.appendChild(document.createTextNode(w))
      chip.onclick = () => insertWord(w)
      chips.appendChild(chip)
    })
    webSection.appendChild(chips)
  })

  container.appendChild(webSection)
}

function renderSongs(word, container) {
  container.innerHTML = ''
  const wordSig = getRhymeSignature(word)

  Object.values(SONGS_WORDS).forEach(group => {
    const section = document.createElement('div')
    section.className = 'drawer-section'

    const synChips = group.synonyms.map(w => {
      const sig    = getRhymeSignature(w)
      const rhymes = wordSig && sig && sig === wordSig
      return `<div class="syn-chip${rhymes ? ' rhymes':''}" onclick="insertWord('${w.replace(/'/g,"\\'")}')">${rhymes ? '<span class="rhyme-dot"></span>':''}${w}</div>`
    }).join('')

    const expandChips = group.expand.map(w =>
      `<div class="feel-chip" onclick="insertWord('${w.replace(/'/g,"\\'")}')">${w}</div>`
    ).join('')

    section.innerHTML = `
      <div class="drawer-label">${group.label}</div>
      <div class="syn-chips">${synChips}</div>
      <div style="margin-top:5px;">
        <div class="rhyme-group-label">expand</div>
        <div class="feel-chips">${expandChips}</div>
      </div>`
    container.appendChild(section)
  })
}

function renderScripture(word, container) {
  container.innerHTML = ''

  if (!bibleIndex) {
    const msg = document.createElement('div')
    msg.className = 'drawer-section'
    msg.innerHTML = '<div class="drawer-label">scripture</div><div class="drawer-loading">bible index not found</div>'
    container.appendChild(msg); return
  }

  const results = bibleIndex[word.toLowerCase()] || []
  const scriptSection = document.createElement('div')
  scriptSection.className = 'drawer-section'

  if (!results.length) {
    scriptSection.innerHTML = `<div class="drawer-label">scripture</div><div class="drawer-loading">"${word}" not found in WEB Bible</div>`
  } else {
    const header = document.createElement('div')
    header.className = 'drawer-label'
    header.textContent = `scripture — ${results.length} occurrence${results.length !== 1 ? 's' : ''}`
    scriptSection.appendChild(header)

    const filterInput = document.createElement('input')
    filterInput.type = 'text'
    filterInput.placeholder = 'filter by book or text...'
    filterInput.className = 'concordance-filter'
    scriptSection.appendChild(filterInput)

    const verseList = document.createElement('div')
    verseList.className = 'verse-list'
    scriptSection.appendChild(verseList)

    function renderVerses(query) {
      verseList.innerHTML = ''
      const q = query.toLowerCase().trim()
      const filtered = q ? results.filter(v => v.ref.toLowerCase().includes(q) || v.text.toLowerCase().includes(q)) : results
      if (!filtered.length) {
        verseList.innerHTML = `<div class="drawer-loading">no matches for "${query}"</div>`
        return
      }
      filtered.slice(0, 50).forEach(v => {
        const row = document.createElement('div')
        row.className = 'verse-row'
        const highlighted = v.text.replace(
          new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'), 'gi'),
          m => `<mark>${m}</mark>`
        )
        row.innerHTML = `<div class="verse-ref">${v.ref}</div><div class="verse-text">${highlighted}</div>`
        row.onclick = () => insertWord(v.ref)
        verseList.appendChild(row)
      })
      if (filtered.length > 50) {
        const more = document.createElement('div')
        more.className = 'drawer-loading'
        more.style.marginTop = '6px'
        more.textContent = `+ ${filtered.length - 50} more — filter by book to narrow`
        verseList.appendChild(more)
      }
    }

    renderVerses('')
    filterInput.addEventListener('input', () => renderVerses(filterInput.value))
  }
  container.appendChild(scriptSection)
}

function renderChips(container, words, perfect) {
  if (!container) return
  container.innerHTML = ''
  if (!words.length) {
    container.innerHTML = '<span style="font-size:10px;color:var(--text3)">none found</span>'
    return
  }
  words.forEach(word => {
    const chip = document.createElement('div')
    chip.className = 'rhyme-chip' + (perfect ? ' perfect' : '')
    chip.textContent = word
    chip.onclick = () => insertWord(word)
    container.appendChild(chip)
  })
}

function closeDrawer() {
  document.getElementById('tool-drawer').classList.remove('open')
  currentDrawerWord = ''
}

function insertWord(word) {
  const area = document.getElementById('idea-area')
  const s = area.selectionStart, e = area.selectionEnd
  area.value = area.value.slice(0,s) + word + area.value.slice(e)
  area.selectionStart = area.selectionEnd = s + word.length
  area.focus(); autoSave()
}

// ════════════════════════════════════════
// SETTINGS
// ════════════════════════════════════════

const THEMES = {
  stave: {
    '--bg': '#1c1c1e', '--bg2': '#252528', '--bg3': '#2e2e32',
    '--border': 'rgba(255,255,255,0.07)', '--border2': 'rgba(255,255,255,0.13)',
    '--text': '#f0e8d8', '--text2': '#9a9080', '--text3': '#4e4a44',
    '--accent': '#c8922a', '--accent2': '#a07420', '--accentbg': 'rgba(200,146,42,0.10)',
    '--teal': '#4caf7d', '--tealbg': 'rgba(76,175,125,0.10)', '--teal2': '#2e8a57',
    '--success': '#4caf7d', '--danger': '#c0392b'
  },
  manuscript: {
    '--bg': '#f5f0e8', '--bg2': '#ede8df', '--bg3': '#e5dfd5',
    '--border': 'rgba(0,0,0,0.08)', '--border2': 'rgba(0,0,0,0.15)',
    '--text': '#2c2418', '--text2': '#7a6e5e', '--text3': '#b0a898',
    '--accent': '#8b4513', '--accent2': '#6b3410', '--accentbg': 'rgba(139,69,19,0.10)',
    '--teal': '#2e8a57', '--tealbg': 'rgba(46,138,87,0.10)', '--teal2': '#1a5c38',
    '--success': '#2e8a57', '--danger': '#c0392b'
  },
  terminal: {
    '--bg': '#000000', '--bg2': '#0a0a0a', '--bg3': '#111111',
    '--border': 'rgba(0,255,65,0.1)', '--border2': 'rgba(0,255,65,0.2)',
    '--text': '#00ff41', '--text2': '#00cc33', '--text3': '#006616',
    '--accent': '#00ff41', '--accent2': '#00cc33', '--accentbg': 'rgba(0,255,65,0.10)',
    '--teal': '#00ff41', '--tealbg': 'rgba(0,255,65,0.10)', '--teal2': '#00cc33',
    '--success': '#00ff41', '--danger': '#ff4141'
  }
}

let currentTheme = 'stave'
let currentFontSize = 13

function openSettings() {
  document.getElementById('settings-overlay').classList.add('open')
  document.getElementById('settings-path-display').textContent = NOTES_DIR
}

function closeSettings() {
  document.getElementById('settings-overlay').classList.remove('open')
}

function setTheme(name) {
  if (!THEMES[name]) return
  currentTheme = name
  const vars = THEMES[name]
  Object.entries(vars).forEach(([k, v]) => document.documentElement.style.setProperty(k, v))
  ;['stave','manuscript','terminal'].forEach(t => {
    document.getElementById('theme-btn-' + t).classList.toggle('active', t === name)
  })
  saveSettings()
}

function changeFontSize(delta) {
  const sizes = [11, 12, 13, 14, 15, 16, 17]
  const idx = sizes.indexOf(currentFontSize)
  const next = sizes[Math.max(0, Math.min(sizes.length - 1, idx + delta))]
  currentFontSize = next
  document.documentElement.style.setProperty('--editor-size', next + 'px')
  document.getElementById('settings-font-val').textContent = next + 'px'
  saveSettings()
}

function revealInFinder() {
  const { shell } = require('electron')
  shell.openPath(NOTES_DIR)
}

function saveSettings() {
  try {
    const p = path.join(NOTES_DIR, 'prefs.json')
    const existing = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {}
    fs.writeFileSync(p, JSON.stringify({ ...existing, theme: currentTheme, fontSize: currentFontSize }, null, 2))
  } catch(e) {}
}

function resetSettings() {
  setTheme('stave')
  currentFontSize = 13
  document.documentElement.style.setProperty('--editor-size', '13px')
  document.getElementById('settings-font-val').textContent = '13px'
  saveSettings()
}

function loadSettings() {
  try {
    const p = path.join(NOTES_DIR, 'prefs.json')
    if (!fs.existsSync(p)) return
    const prefs = JSON.parse(fs.readFileSync(p, 'utf8'))
    if (prefs.theme && THEMES[prefs.theme]) setTheme(prefs.theme)
    if (prefs.fontSize) {
      currentFontSize = prefs.fontSize
      document.documentElement.style.setProperty('--editor-size', prefs.fontSize + 'px')
      const el = document.getElementById('settings-font-val')
      if (el) el.textContent = prefs.fontSize + 'px'
    }
  } catch(e) {}
}

// AUDIO RECORDINGS
// ════════════════════════════════════════

function toggleRecordingsPanel() {
  recordingsOpen = !recordingsOpen
  document.getElementById('recordings-panel').classList.toggle('open', recordingsOpen)
  document.getElementById('rec-toggle').classList.toggle('active', recordingsOpen)
  if (recordingsOpen) renderRecordingsPanel()
}

function recColor(filename) {
  if (!filename) return RECORDING_COLORS[0]
  let h = 0
  for (let i = 0; i < filename.length; i++) h = (h * 31 + filename.charCodeAt(i)) & 0xffff
  return RECORDING_COLORS[h % RECORDING_COLORS.length]
}

function renderRecordingsPanel() {
  const tab = tabs[currentTabIndex]
  if (!tab) return
  const panel = document.getElementById('recordings-panel')
  panel.innerHTML = ''
  const inner = document.createElement('div')
  inner.className = 'rec-panel-inner'
  const recs = tab.recordings || []

  recs.forEach((filename, i) => {
    const color = recColor(filename)
    const row = document.createElement('div')
    row.className = 'rec-row'

    const btn = document.createElement('button')
    btn.className = 'rec-btn'
    btn.style.background = color

    if (activeRecorderIndex === i) {
      btn.classList.add('recording')
      btn.innerHTML = '&#9632;'
      btn.title = 'stop recording'
      btn.onclick = () => stopRecording()
    } else if (currentPlayingIndex === i) {
      btn.innerHTML = '&#9632;'
      btn.title = 'stop'
      btn.style.opacity = '0.8'
      btn.onclick = () => stopAudio()
    } else if (filename) {
      btn.innerHTML = '&#9654;'
      btn.title = 'play'
      btn.onclick = () => playRecording(filename, i)
    } else {
      btn.innerHTML = '&#9210;'
      btn.title = 'start recording'
      btn.onclick = () => startRecording(i)
    }
    row.appendChild(btn)

    if (activeRecorderIndex === i) {
      const timer = document.createElement('span')
      timer.className = 'rec-timer'
      timer.id = 'rec-timer-display'
      timer.textContent = '0:00'
      row.appendChild(timer)
    }

    const arrows = document.createElement('div')
    arrows.className = 'rec-arrows'
    if (i > 0) {
      const up = document.createElement('button')
      up.className = 'rec-arrow'
      up.textContent = '↑'
      up.onclick = () => moveRecording(i, -1)
      arrows.appendChild(up)
    }
    if (i < recs.length - 1) {
      const dn = document.createElement('button')
      dn.className = 'rec-arrow'
      dn.textContent = '↓'
      dn.onclick = () => moveRecording(i, 1)
      arrows.appendChild(dn)
    }
    row.appendChild(arrows)

    const del = document.createElement('button')
    del.className = 'rec-delete'
    del.textContent = '✕'
    del.title = 'delete'
    del.onclick = () => deleteRecording(i)
    row.appendChild(del)
    inner.appendChild(row)
  })

  if (recs.length === 0) {
    const hint = document.createElement('span')
    hint.className = 'rec-hint'
    hint.textContent = 'audio memos'
    inner.appendChild(hint)
  }

  const addBtn = document.createElement('button')
  addBtn.className = 'rec-add-btn'
  addBtn.textContent = '+'
  addBtn.onclick = addRecordingSlot
  inner.appendChild(addBtn)
  panel.appendChild(inner)
}

function addRecordingSlot() {
  const tab = tabs[currentTabIndex]
  if (!tab) return
  if (!tab.recordings) tab.recordings = []
  tab.recordings.push(null)
  renderRecordingsPanel()
}

async function startRecording(index) {
  if (activeRecorder) return
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    const chunks = []
    activeRecorder = new MediaRecorder(stream)
    activeRecorderIndex = index
    recordingStartTime = Date.now()

    recordingTimerInterval = setInterval(() => {
      const secs = Math.floor((Date.now() - recordingStartTime) / 1000)
      const el = document.getElementById('rec-timer-display')
      if (el) el.textContent = `${Math.floor(secs/60)}:${String(secs%60).padStart(2,'0')}`
    }, 500)

    activeRecorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data) }

    activeRecorder.onstop = () => {
      clearInterval(recordingTimerInterval)
      recordingTimerInterval = null
      stream.getTracks().forEach(t => t.stop())

      const blob = new Blob(chunks, { type: 'audio/webm' })
      const filename = `rec-${Date.now()}-${Math.random().toString(36).slice(2,6)}.webm`
      const filepath = path.join(RECORDINGS_DIR, filename)

      const reader = new FileReader()
      reader.onload = () => {
        try {
          fs.writeFileSync(filepath, Buffer.from(reader.result))
          const tab = tabs[currentTabIndex]
          if (tab) {
            if (!tab.recordings) tab.recordings = []
            tab.recordings[activeRecorderIndex] = filename
            autoSave()
          }
        } catch(e) { console.error('save recording failed', e) }
        activeRecorder = null
        activeRecorderIndex = -1
        renderRecordingsPanel()
      }
      reader.readAsArrayBuffer(blob)
    }

    activeRecorder.start()
    renderRecordingsPanel()
  } catch(e) {
    activeRecorder = null
    activeRecorderIndex = -1
    console.error('microphone access failed', e)
  }
}

function stopRecording() {
  if (activeRecorder && activeRecorder.state === 'recording') activeRecorder.stop()
}

function stopAudio() {
  if (currentAudio) { currentAudio.pause(); currentAudio = null }
  currentPlayingIndex = -1
  renderRecordingsPanel()
}

function playRecording(filename, index) {
  const filepath = path.join(RECORDINGS_DIR, filename)
  if (!fs.existsSync(filepath)) return
  stopAudio()
  currentAudio = new Audio('file://' + filepath)
  currentPlayingIndex = index
  currentAudio.onended = () => { currentAudio = null; currentPlayingIndex = -1; renderRecordingsPanel() }
  currentAudio.play()
  renderRecordingsPanel()
}

function moveRecording(index, dir) {
  const tab = tabs[currentTabIndex]
  if (!tab || !tab.recordings) return
  const ni = index + dir
  if (ni < 0 || ni >= tab.recordings.length) return
  ;[tab.recordings[index], tab.recordings[ni]] = [tab.recordings[ni], tab.recordings[index]]
  renderRecordingsPanel()
  autoSave()
}

function deleteRecording(index) {
  const tab = tabs[currentTabIndex]
  if (!tab || !tab.recordings) return
  const filename = tab.recordings[index]
  if (currentPlayingIndex === index) stopAudio()
  if (filename) {
    const fp = path.join(RECORDINGS_DIR, filename)
    try { if (fs.existsSync(fp)) fs.unlinkSync(fp) } catch(e) {}
  }
  tab.recordings.splice(index, 1)
  if (currentPlayingIndex > index) currentPlayingIndex--
  renderRecordingsPanel()
  autoSave()
}

// ════════════════════════════════════════
// TASK EXTRACTION
// ════════════════════════════════════════

const ACTION_WORDS = [
  'need to','needs to','have to','has to','must','should',
  'call','text','email','send','write','finish','complete',
  'schedule','book','order','buy','get','pick up','drop off',
  'follow up','follow-up','reach out','contact','remind',
  'submit','review','edit','update','fix','check','confirm',
  'prepare','plan','arrange','organize','set up','demo',
  'record','print','deliver','return','pay','invoice',
  'add','promote','announce','post','share','upload','download',
  'research','draft','pitch','present','assign','delegate',
  'approve','request','respond','reply','forward','create',
  'build','design','launch','test','finalize','publish',
  'message','meet','film','caption','graphic','artwork','budget'
]

function scoreSentence(s) {
  const lower = s.toLowerCase().trim()
  if (s.trim().startsWith('•') || s.trim().startsWith('-')) return 10
  if (s.trim().startsWith('>>')) return 10
  let score = 0
  const firstWord = lower.split(' ')[0]
  const firstTwo  = lower.split(' ').slice(0,2).join(' ')
  const imperatives = ['call','send','write','email','get','buy','fix','check','review',
    'schedule','book','contact','finish','complete','submit','update','order','record',
    'print','demo','prepare','add','promote','post','share','create','build','design',
    'launch','film','message','meet','finalize','draft','research','follow','invite',
    'confirm','deliver','edit','assign','coordinate','publish','request']
  if (imperatives.includes(firstWord)) score += 5
  if (['need to','have to','must','should','follow up','reach out'].includes(firstTwo)) score += 4
  return score
}

function extractTasks() {
  const text = document.getElementById('admin-area').value
  if (!text.trim()) return
  const tab = tabs[currentTabIndex]
  const existing = [
    ...(tab?.tasks || []).map(t => t.text.trim().toLowerCase())
  ]
  let added = 0
  text.split(/(?<=[.!?\n])/).map(s => s.trim()).filter(s => s.length > 4)
    .map(s => ({ text: s.replace(/^[•\->>\s]+/,'').trim(), score: scoreSentence(s) }))
    .filter(s => s.score >= 4 && s.text.length > 0 && !existing.includes(s.text.trim().toLowerCase()))
    .forEach(c => { addTask(c.text, false, null); added++ })
  if (added > 0) { updateTaskCount(); autoSave() }
  else {
    const empty = document.querySelector('.empty-tasks')
    if (empty) empty.textContent = 'no new tasks found — try >> to flag lines'
  }
}

// ════════════════════════════════════════
// TASKS UI
// ════════════════════════════════════════

function addTask(text, done=false, reminder=null) {
  const list  = document.getElementById('task-list')
  const empty = list.querySelector('.empty-tasks')
  if (empty) empty.remove()

  const row = document.createElement('div')
  row.className = 'task-row'
  if (reminder) row.dataset.reminder = reminder

  const check = document.createElement('div')
  check.className = 'task-check' + (done ? ' done' : '')

  const body = document.createElement('div')
  body.className = 'task-body'

  const label = document.createElement('div')
  label.className = 'task-text' + (done ? ' done' : '')
  label.textContent = text
  label.contentEditable = true
  label.spellcheck = false
  label.onblur = autoSave

  const actions = document.createElement('div')
  actions.className = 'task-actions'

  const dot = document.createElement('div')
  dot.className = 'reminder-dot'
  dot.style.display = reminder ? 'block' : 'none'

  const reminderBtn = document.createElement('button')
  reminderBtn.className = 'task-reminder-btn' + (reminder ? ' set' : '')
  reminderBtn.textContent = reminder ? 'edit reminder' : '+ reminder'
  reminderBtn.onclick = () => openReminder(row, label.textContent, row.dataset.reminder || null)

  const reminderInfo = document.createElement('span')
  reminderInfo.className = 'task-reminder-info'
  if (reminder) {
    try {
      const d = new Date(reminder)
      if (!isNaN(d)) {
        reminderInfo.textContent = `${(d.getMonth()+1).toString().padStart(2,'0')}/${d.getDate().toString().padStart(2,'0')}/${d.getFullYear().toString().slice(2)} ${d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}`
      }
    } catch(e) {}
  }

  const deleteBtn = document.createElement('button')
  deleteBtn.className = 'task-delete-btn'
  deleteBtn.textContent = '×'
  deleteBtn.onclick = () => { row.remove(); updateTaskCount(); autoSave() }

  actions.appendChild(dot); actions.appendChild(reminderBtn)
  actions.appendChild(reminderInfo); actions.appendChild(deleteBtn)
  body.appendChild(label); body.appendChild(actions)

  check.onclick = () => {
    check.classList.toggle('done')
    label.classList.toggle('done')
    updateTaskCount(); autoSave()
  }

  row.appendChild(check); row.appendChild(body)
  list.appendChild(row)
  updateTaskCount()
}

function renderTasks(tasks) {
  const list = document.getElementById('task-list')
  list.innerHTML = ''
  if (!tasks || !tasks.length) {
    list.innerHTML = '<div class="empty-tasks">no tasks yet — hit extract below</div>'
    return
  }
  tasks.forEach(t => addTask(t.text, t.done, t.reminder))
  updateTaskCount()
}

function getTasksFromDOM() {
  return Array.from(document.querySelectorAll('.task-row')).map(row => ({
    text:     row.querySelector('.task-text').textContent.trim(),
    done:     row.querySelector('.task-check').classList.contains('done'),
    reminder: row.dataset.reminder || null
  }))
}

function updateTaskCount() {
  const total = document.querySelectorAll('.task-row').length
  const done  = document.querySelectorAll('.task-check.done').length
  document.getElementById('task-count').textContent = total > 0 ? `${done}/${total} done` : ''
}

// ════════════════════════════════════════
// REMINDERS
// ════════════════════════════════════════

function getNearest30() {
  const now = new Date(), d = new Date(now)
  d.setMinutes(now.getMinutes() < 30 ? 30 : 0, 0, 0)
  if (now.getMinutes() >= 30) d.setHours(d.getHours() + 1)
  return d.toTimeString().slice(0,5)
}

function openReminder(row, taskText, existingReminder) {
  currentReminderRow = row
  document.getElementById('reminder-task-label').textContent =
    taskText.length > 38 ? taskText.slice(0,38) + '…' : taskText

  const now = new Date()
  document.getElementById('reminder-date').value = now.toISOString().slice(0,10)

  if (existingReminder) {
    try {
      const d = new Date(existingReminder)
      if (!isNaN(d)) {
        document.getElementById('reminder-date').value = d.toISOString().slice(0,10)
        document.getElementById('reminder-time').value = d.toTimeString().slice(0,5)
      } else {
        document.getElementById('reminder-time').value = getNearest30()
      }
    } catch(e) { document.getElementById('reminder-time').value = getNearest30() }
  } else {
    document.getElementById('reminder-time').value = getNearest30()
  }
  document.getElementById('reminder-popup').classList.add('open')
}

function closeReminder() { document.getElementById('reminder-popup').classList.remove('open') }

function setReminder() {
  const date = document.getElementById('reminder-date').value
  const time = document.getElementById('reminder-time').value
  const task = currentReminderRow?.querySelector('.task-text')?.textContent || ''
  if (!date || !time) { alert('Please set a date and time'); return }
  ipcRenderer.send('schedule-reminder', { title: task, date, time })
}

ipcRenderer.on('reminder-set', (event, data) => {
  if (data.ok) {
    if (currentReminderRow) {
      const btn  = currentReminderRow.querySelector('.task-reminder-btn')
      const info = currentReminderRow.querySelector('.task-reminder-info')
      const dot  = currentReminderRow.querySelector('.reminder-dot')
      const isoString = `${data.date}T${data.time}`
      currentReminderRow.dataset.reminder = isoString
      if (btn)  { btn.textContent = 'edit reminder'; btn.classList.add('set') }
      if (dot)  dot.style.display = 'block'
      if (info) {
        const d = new Date(isoString)
        info.textContent = `${(d.getMonth()+1).toString().padStart(2,'0')}/${d.getDate().toString().padStart(2,'0')}/${d.getFullYear().toString().slice(2)} ${d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}`
      }
      autoSave()
    }
    closeReminder()
    currentReminderRow = null
  } else {
    alert('Could not set reminder: ' + data.reason)
    currentReminderRow = null
  }
})

function rescheduleReminders() {
  const allReminders = []
  const now = new Date()
  ;['write','plan'].forEach(mode => {
    const dir = getDirForMode(mode)
    try {
      fs.readdirSync(dir).filter(f => f.endsWith('.md')).forEach(filename => {
        const raw = fs.readFileSync(path.join(dir, filename), 'utf8')
        const lines = raw.split('\n')
        let currentTask = null
        lines.forEach(line => {
          if (line.startsWith('- [ ] ') || line.startsWith('- [x] ')) currentTask = line.slice(6)
          if (line.startsWith('  reminder: ') && currentTask) {
            const isoString = line.slice(12).trim()
            const reminderTime = new Date(isoString)
            if (!isNaN(reminderTime) && reminderTime > now)
              allReminders.push({ title: currentTask, isoString })
          }
        })
      })
    } catch(e) {}
  })
  if (allReminders.length > 0) ipcRenderer.send('reschedule-reminders', allReminders)
}

// ════════════════════════════════════════
// WIN MODE
// ════════════════════════════════════════

const WIN_MODES = ['hide','float','free']

function cycleWinMode() {
  const idx = WIN_MODES.indexOf(winModeState)
  winModeState = WIN_MODES[(idx+1) % WIN_MODES.length]
  updateWinModeBtns()
  ipcRenderer.send('set-win-mode', winModeState)
}

function updateWinModeBtns() {
  const active = winModeState !== 'hide'
  ;['win-mode-btn','win-mode-btn-plan'].forEach(id => {
    const btn = document.getElementById(id)
    if (!btn) return
    btn.textContent = winModeState
    btn.classList.toggle('active', active)
  })
}

// ════════════════════════════════════════
// LOCK IN
// ════════════════════════════════════════

function openLockIn() {
  const tab = tabs[currentTabIndex]
  if (!tab) return

  clearTimeout(saveTimer)
  syncTabFromDOM()
  writeTabToDisk(tab)

  if (tab.mode === 'plan') {
    const planTabs = tabs
      .map((t, i) => ({ title: t.title || 'untitled', filepath: t.filepath, index: i, mode: t.mode }))
      .filter(t => t.mode === 'plan')

    ipcRenderer.send('open-lockin-plan', {
      title:       tab.title,
      filepath:    tab.filepath,
      admin:       tab.admin || '',
      planContext: tab.planContext || '',
      tasks:       tab.tasks || [],
      phases:      tab.phases || [],
      links:       tab.links || [],
      planTabs,
      theme:       currentTheme
    })
  } else {
    ipcRenderer.send('open-lockin', {
      mode:       tab.mode,
      content:    tab.idea || '',
      title:      tab.title,
      filepath:   tab.filepath,
      recordings: tab.recordings || []
    })
  }
}

function openSearch()    { ipcRenderer.send('open-search') }
function openReminders() { ipcRenderer.send('open-reminders') }

// ════════════════════════════════════════
// PDF EXPORT
// ════════════════════════════════════════

function renderMarkdown(text) {
  const escaped = text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
  return escaped.split('\n').map(line => {
    line = line.replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>')
    line = line.replace(/_(.+?)_/g,'<em>$1</em>')
    if (line.startsWith('&gt; ')) return '<blockquote>' + line.slice(5) + '</blockquote>'
    if (line.startsWith('• ') || line.startsWith('- ')) return '<span style="color:var(--accent)">•</span> ' + line.slice(2)
    return line
  }).join('\n')
}

function exportPDF() {
  const tab     = tabs[currentTabIndex]
  const title   = tab?.title || 'untitled'
  const idea    = document.getElementById('idea-area').value
  const context = document.getElementById('context-area').value

  const html = `<html><head><style>
    body { font-family: Georgia, serif; max-width: 600px; margin: 60px auto; color: #1c1c1e; line-height: 1.8; }
    h1 { font-size: 22px; font-weight: 600; margin-bottom: 6px; }
    .meta { font-size: 12px; color: #888; margin-bottom: 32px; }
    .idea { font-size: 15px; white-space: pre-wrap; }
    .context { font-size: 12px; color: #666; margin-top: 32px; border-top: 1px solid #eee; padding-top: 16px; }
    strong { font-weight: 700; } em { font-style: italic; }
    blockquote { border-left: 3px solid #c8922a; padding-left: 14px; color: #555; margin: 12px 0; }
  </style></head><body>
    <h1>${title}</h1>
    <div class="meta">S†AVE · ${new Date().toLocaleDateString()}</div>
    <div class="idea">${renderMarkdown(idea)}</div>
    ${context ? `<div class="context">${context}</div>` : ''}
  </body></html>`

  ipcRenderer.send('export-pdf', { html, title })
}

// ════════════════════════════════════════
// LONGFORM TEMPLATES
// ════════════════════════════════════════

function chooseLongformTemplate(callback) {
  const templates = [
    { key: 'blank',  label: 'blank',       desc: 'empty note' },
    { key: 'sermon', label: 'sermon',      desc: 'scripture · big idea · points · application' },
    { key: 'essay',  label: 'essay',       desc: 'intro · argument · conclusion' },
    { key: 'study',  label: 'bible study', desc: 'observe · interpret · apply · pray' }
  ]

  const picker  = document.getElementById('template-picker')
  const options = document.getElementById('template-options')
  options.innerHTML = ''
  picker.style.display = 'flex'

  templates.forEach(t => {
    const btn = document.createElement('button')
    btn.style.cssText = 'font-family:JetBrains Mono,monospace;font-size:11px;padding:10px 14px;border-radius:6px;border:0.5px solid var(--border2);color:var(--text2);background:var(--bg2);cursor:pointer;text-align:left;transition:all 0.12s;outline:none;'
    btn.onmouseenter = () => { btn.style.borderColor = 'var(--accent2)'; btn.style.color = 'var(--text)' }
    btn.onmouseleave = () => { btn.style.borderColor = 'var(--border2)'; btn.style.color = 'var(--text2)' }
    btn.innerHTML = `<div style="font-weight:500;color:var(--text);margin-bottom:3px;">${t.label}</div><div style="font-size:9px;color:var(--text3)">${t.desc}</div>`
    btn.onclick = () => { picker.style.display = 'none'; callback(t.key) }
    options.appendChild(btn)
  })
}

function getTemplateContent(key) {
  const templates = {
    blank:  { title: '', content: '' },
    sermon: { title: 'New Sermon',     content: '# Series\n\n\n# Scripture\n\n\n# Big Idea\nOne sentence that captures everything.\n\n\n# Point 1\n\n\n# Point 2\n\n\n# Point 3\n\n\n# Illustration\n\n\n# Application\n\n\n# Call to Action' },
    essay:  { title: 'New Essay',      content: '# Introduction\n\n\n# Main Argument\n\n\n# Supporting Point 1\n\n\n# Supporting Point 2\n\n\n# Supporting Point 3\n\n\n# Conclusion' },
    study:  { title: 'New Bible Study',content: '# Passage\n\n\n# Observation\nWhat does it say?\n\n\n# Interpretation\nWhat does it mean?\n\n\n# Application\nWhat do I do with it?\n\n\n# Prayer' }
  }
  return templates[key] || templates.blank
}

// ════════════════════════════════════════
// IPC LISTENERS
// ════════════════════════════════════════

function bindIPC() {
  ipcRenderer.on('load-note', (event, { filename, mode }) => {
    const tab = loadNoteAsTab(filename, mode)
    if (tab) {
      clearTimeout(saveTimer)
      syncTabFromDOM()
      writeTabToDisk(tabs[currentTabIndex])
      tabs.push(tab)
      currentTabIndex = tabs.length - 1
      newTabMode = mode
      isSwitching = false
      loadTabIntoDOM(tab)
      renderTabBar()
      saveTabPrefs()
    }
  })

  ipcRenderer.on('new-note', (event, mode) => {
    newTabMode = mode; newTab()
  })

  ipcRenderer.on('lockin-closed', (event, updatedContent) => {
    if (!updatedContent) return
    const tab = tabs[currentTabIndex]
    if (!tab) return
    if (tab.mode === 'write' || tab.mode === 'longform') {
      tab.idea = updatedContent
      document.getElementById('idea-area').value = updatedContent
      updateSyllableOverlay()
    } else {
      tab.admin = updatedContent
      document.getElementById('admin-area').value = updatedContent
    }
    writeTabToDisk(tab)
  })

  ipcRenderer.on('lockin-plan-closed', (event, data) => {
    if (!data) return
    const tab = tabs[currentTabIndex]
    if (!tab || tab.mode !== 'plan') return
    tab.admin       = data.admin || ''
    tab.planContext = data.planContext || ''
    tab.tasks       = data.tasks || []
    tab.phases      = data.phases || []
    tab.links       = data.links || []
    document.getElementById('admin-area').value = tab.admin
    document.getElementById('plan-context-input').value = tab.planContext
    renderTasks(tab.tasks)
    writeTabToDisk(tab)
  })

  ipcRenderer.on('add-selection-as-task', (event, text) => {
    // prefer current tab if plan, then last active plan tab, then first plan tab found
    let planTabIndex = -1
    if (tabs[currentTabIndex]?.mode === 'plan') {
      planTabIndex = currentTabIndex
    } else if (lastPlanTabIndex !== -1 && tabs[lastPlanTabIndex]?.mode === 'plan') {
      planTabIndex = lastPlanTabIndex
    } else {
      planTabIndex = tabs.findIndex(t => t.mode === 'plan')
    }
    if (planTabIndex === -1) {
      const tab = emptyTab('plan')
      tabs.push(tab)
      planTabIndex = tabs.length - 1
      createNoteFile(tab, () => {})
    }
    switchTab(planTabIndex)
    addTask(text, false, null)
    updateTaskCount()
    autoSave()
  })

  ipcRenderer.on('reload-lockin-plan', (event, { index }) => {
    switchTab(index)
    const tab = tabs[currentTabIndex]
    if (!tab || tab.mode !== 'plan') return
    const planTabs = tabs
      .map((t, i) => ({ title: t.title || 'untitled', filepath: t.filepath, index: i, mode: t.mode }))
      .filter(t => t.mode === 'plan')
    ipcRenderer.send('push-lockin-plan-data', {
      title: tab.title, filepath: tab.filepath,
      admin: tab.admin || '', planContext: tab.planContext || '',
      tasks: tab.tasks || [], phases: tab.phases || [],
      links: tab.links || [], planTabs
    })
  })

  ipcRenderer.on('open-file-path', (event, filePath) => {
    try {
      const raw      = fs.readFileSync(filePath, 'utf8')
      const typeLine = raw.split('\n').find(l => l.startsWith('type: '))
      const mode     = typeLine ? typeLine.slice(5).trim() : 'write'
      const filename = path.basename(filePath)
      const tab      = emptyTab(mode)
      tab.filename = filename
      tab.filepath = filePath
      Object.assign(tab, parseNote(raw, mode))
      clearTimeout(saveTimer)
      syncTabFromDOM()
      writeTabToDisk(tabs[currentTabIndex])
      tabs.push(tab)
      currentTabIndex = tabs.length - 1
      newTabMode = mode
      isSwitching = false
      loadTabIntoDOM(tab)
      renderTabBar()
      saveTabPrefs()
    } catch(e) {}
  })

  ipcRenderer.on('drawer-lookup', async (event, word) => {
    const clean = word.replace(/[^a-z]/gi, '').toLowerCase()
    if (clean.length < 2) return

    const { perfect, near } = findRhymes(clean)
    const wordSig = getRhymeSignature(clean)

    const syns = await getSynonyms(clean)
    const synonyms = syns.map(s => {
      const synWord = s.split(' ')[0]
      const synSig  = getRhymeSignature(synWord)
      return { word: s, rhymes: !!(wordSig && synSig && synSig === wordSig) }
    })

    const songs = Object.values(SONGS_WORDS).map(group => ({
      label: group.label,
      synonyms: group.synonyms.map(w => {
        const sig = getRhymeSignature(w)
        return { word: w, rhymes: !!(wordSig && sig && sig === wordSig) }
      }),
      expand: group.expand
    }))

    const scripture = bibleIndex ? (bibleIndex[clean] || []) : []

    const songMatches = findWordWebMatches(clean)
    const wordweb = (songMatches.length ? songMatches : getPaletteCategories(clean)).map(group => ({
      label: group.label,
      words: group.words || [...(group.synonyms || []), ...(group.expand || [])],
      fromPalette: !songMatches.length
    }))

    ipcRenderer.send('lockin-drawer-results', {
      word:      clean,
      syllables: countSyllables(clean),
      rhymes:    { perfect, near },
      synonyms,
      wordweb,
      songs,
      scripture
    })
  })

  ipcRenderer.on('lockin-recordings-update', (event, recordings) => {
    const tab = tabs[currentTabIndex]
    if (!tab) return
    tab.recordings = recordings
    renderRecordingsPanel()
    writeTabToDisk(tab)
  })
}

// ════════════════════════════════════════
// KEYBOARD BINDINGS
// ════════════════════════════════════════

function bindKeys() {
  document.getElementById('idea-area').addEventListener('keydown', handleBullet)
  document.getElementById('admin-area').addEventListener('keydown', handleBullet)

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { closeDrawer(); closeReminder(); hideMarkdownHint(); closeSettings() }
    if (e.key === 'f' && e.metaKey) { e.preventDefault(); openSearch() }
    if (e.key === 'r' && e.metaKey) { e.preventDefault(); openReminders() }
    if (e.key === 'b' && e.metaKey) { e.preventDefault(); fmtToggle('**') }
    if (e.key === 'i' && e.metaKey) { e.preventDefault(); fmtToggle('_') }
    if (e.key === 't' && e.metaKey) { e.preventDefault(); newTab() }
    if (e.key === 'n' && e.metaKey) { e.preventDefault(); newTab() }
    if (e.key === 's' && e.metaKey) {
      e.preventDefault()
      syncTabFromDOM()
      saveCurrentTab()
      const meta = document.getElementById('note-meta')
      meta.textContent = 'saved ✓'
      const tab = tabs[currentTabIndex]
      setTimeout(() => { if (tab?.filepath) meta.textContent = formatMeta(tab.filepath) }, 1500)
    }
  })

  // input listeners — sync tab object on every keystroke
  document.getElementById('idea-area').addEventListener('input', () => {
    autoSave(); updateSyllableOverlay()
  })
  document.getElementById('context-area').addEventListener('input', autoSave)
  document.getElementById('admin-area').addEventListener('input', autoSave)
  document.getElementById('plan-context-input').addEventListener('input', autoSave)
  document.getElementById('note-title').addEventListener('input', () => {
    if (tabs[currentTabIndex]) tabs[currentTabIndex].title = document.getElementById('note-title').value
    autoSave()
  })
}

// ════════════════════════════════════════
// SELECTION → DRAWER
// ════════════════════════════════════════

function bindSelection() {
  document.getElementById('idea-area').addEventListener('mouseup', () => {
    setTimeout(() => {
      const sel = window.getSelection()?.toString().trim()
      if (sel && sel.length > 1 && !sel.includes(' ')) openDrawer(sel)
    }, 50)
  })
}

// ════════════════════════════════════════
// INIT
// ════════════════════════════════════════

function init() {
  loadCMU()
  loadWordNet()
  loadBibleIndex()
  ensureDirs()
  loadSettings()

  const prefs = loadPrefs()
  if (prefs.winMode) { winModeState = prefs.winMode; updateWinModeBtns() }

  // restore tabs from prefs
  const savedTabs = prefs.tabs || []
  if (savedTabs.length > 0) {
    savedTabs.forEach(saved => {
      if (saved.filepath && fs.existsSync(saved.filepath)) {
        const tab = emptyTab(saved.mode)
        tab.filename = saved.filename
        tab.filepath = saved.filepath
        const raw = fs.readFileSync(saved.filepath, 'utf8')
        Object.assign(tab, parseNote(raw, saved.mode))
        tabs.push(tab)
      }
    })
  }

  if (tabs.length === 0) {
    const writeFiles = getNotesList('write')
    const planFiles  = getNotesList('plan')
    if (writeFiles.length > 0) { const tab = loadNoteAsTab(writeFiles[0], 'write'); if (tab) tabs.push(tab) }
    if (planFiles.length > 0)  { const tab = loadNoteAsTab(planFiles[0],  'plan');  if (tab) tabs.push(tab) }
    if (tabs.length === 0)     { const tab = emptyTab('write'); createNoteFile(tab, () => {}); tabs.push(tab) }
  }

  currentTabIndex = Math.min(prefs.currentTabIndex || 0, tabs.length - 1)

  // sync mode toggle to match current tab
  newTabMode = tabs[currentTabIndex]?.mode === 'plan' ? 'plan' : 'write'

  loadTabIntoDOM(tabs[currentTabIndex])
  renderTabBar()
  setNewTabMode(newTabMode)
  bindKeys()
  bindSelection()
  bindIPC()
  rescheduleReminders()
}

init()