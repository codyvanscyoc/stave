const fs = require('fs')
const path = require('path')
const os = require('os')
const { ipcRenderer } = require('electron')

const NOTES_DIR = path.join(os.homedir(), 'Library', 'Mobile Documents', 'com~apple~CloudDocs', 'Stave')
const WRITE_DIR = path.join(NOTES_DIR, 'write')
const PLAN_DIR  = path.join(NOTES_DIR, 'plan')
const LONGFORM_DIR = path.join(NOTES_DIR, 'longform')
const PROJECTS_DIR = path.join(NOTES_DIR, 'projects')
const BIBLE_INDEX_PATH = path.join(__dirname, 'bible-index.json')
// ── TAB SYSTEM ──
// Each tab: { filename, filepath, mode, title, idea, context, tags, planContext, admin, tasks }
let tabs = []
let currentTabIndex = 0
let newTabMode = 'write' // what mode the next new tab will be

let saveTimer = null
let currentReminderRow = null
let winModeState = 'hide'
let cmuDict = null
let wn = null
let bibleIndex = null
let currentDrawerWord = ''
let currentSource = 'general'
let fmtModes = {}

// ── CMU ──
function loadCMU() {
  try { const cmu = require('cmudict'); cmuDict = cmu.dict() }
  catch(e) { cmuDict = {} }
}

// ── WORDNET ──
function loadWordNet() {
  try { const natural = require('natural'); wn = new natural.WordNet() }
  catch(e) { wn = null }
}

// ── BIBLE INDEX ──
function loadBibleIndex() {
  try {
    if (fs.existsSync(BIBLE_INDEX_PATH))
      bibleIndex = JSON.parse(fs.readFileSync(BIBLE_INDEX_PATH, 'utf8'))
  } catch(e) { bibleIndex = null }
}

// ── WORDNET SYNONYMS ──
const CLEAN_WORD = /^[a-z][a-z\s]{0,20}$/
const BLOCK = new Set(['fuck','shit','ass','damn','hell','sex','sexy','crap','piss',
  'cock','dick','bitch','bastard','whore','slut','nude','naked','erotic','explicit',
  'screw','bang','hump','bonk','shag'])

function getSynonyms(word) {
  return new Promise((resolve) => {
    if (!wn) { resolve([]); return }
    wn.lookup(word, (results) => {
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

// ── CMU PHONETICS ──
function getPhones(word) {
  if (!cmuDict) return null
  const entry = cmuDict[word.toUpperCase()]
  if (!entry) return null
  return Array.isArray(entry[0]) ? entry[0] : entry
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
  if (!cmuDict) return { perfect: [], near: [] }
  const sig = getRhymeSignature(word)
  const vowel = getVowelSound(word)
  const cons = getEndingConsonants(word)
  const wordUp = word.toUpperCase()
  const perfect = [], near = []

  Object.keys(cmuDict).forEach(key => {
    if (key === wordUp) return
    const candidate = key.toLowerCase()
    if (!/^[a-z]+$/.test(candidate)) return

    if (sig) {
      const candSig = getRhymeSignature(candidate)
      if (candSig === sig) {
        if (perfect.length < 16) perfect.push(candidate)
        return
      }
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

// ── SONGS DICTIONARY ──
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

// ── SYLLABLE OVERLAY ──
function updateSyllableOverlay() {
  const overlay = document.getElementById('syl-overlay')
  const lines = document.getElementById('idea-area').value.split('\n')
  overlay.innerHTML = ''
  lines.forEach(line => {
    const div = document.createElement('div')
    div.className = 'syl-count'
    if (line.trim().length > 0) div.textContent = countLineSyllables(line)
    overlay.appendChild(div)
  })
}

// ── MARKDOWN ──
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

function showMarkdownHint() { document.getElementById('markdown-hint').style.display = 'block' }
function hideMarkdownHint() { document.getElementById('markdown-hint').style.display = 'none' }

function exportPDF() {
  const tab = tabs[currentTabIndex]
  const title = tab?.title || 'untitled'
  const idea = document.getElementById('idea-area').value
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

// ── FORMATTING ──
function fmtToggle(marker) {
  const area = document.getElementById('idea-area')
  const s = area.selectionStart, e = area.selectionEnd

  if (s !== e) { fmtWrap(marker, marker); return }

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
  area.selectionEnd = s + before.length + (selected || 'text').length
  area.focus(); autoSave()
}

// ── SOURCE TOGGLE ──
function setSource(src) {
  currentSource = src
  ;['general','songs','scripture'].forEach(s => {
    document.getElementById('src-'+s).classList.toggle('active', s === src)
  })
  if (currentDrawerWord) renderDrawerContent(currentDrawerWord)
}

// ── TOOL DRAWER ──
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
  document.getElementById('drawer-content').innerHTML = '<div class="drawer-loading">looking up...</div>'
  document.getElementById('tool-drawer').classList.add('open')

  await renderDrawerContent(clean)
}

async function renderDrawerContent(word) {
  const container = document.getElementById('drawer-content')
  container.innerHTML = '<div class="drawer-loading">looking up...</div>'
  if (currentSource === 'general') await renderGeneral(word, container)
  else if (currentSource === 'songs') renderSongs(word, container)
  else if (currentSource === 'scripture') renderScripture(word, container)
}

async function renderGeneral(word, container) {
  container.innerHTML = ''
  const wordSig = getRhymeSignature(word)

  const rhymeSection = document.createElement('div')
  rhymeSection.className = 'drawer-section'
  const { perfect, near } = findRhymes(word)
  rhymeSection.innerHTML = `
    <div class="drawer-label">rhymes</div>
    <div class="rhyme-group">
      <div class="rhyme-group-label">perfect</div>
      <div class="rhyme-chips" id="rc-perfect"></div>
    </div>
    <div class="rhyme-group">
      <div class="rhyme-group-label">near</div>
      <div class="rhyme-chips" id="rc-near"></div>
    </div>`
  container.appendChild(rhymeSection)
  renderChips(document.getElementById('rc-perfect'), perfect, true)
  renderChips(document.getElementById('rc-near'), near, false)

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
      const synSig = getRhymeSignature(synWord)
      const rhymes = wordSig && synSig && synSig === wordSig
      const chip = document.createElement('div')
      chip.className = 'syn-chip' + (rhymes ? ' rhymes' : '')
      if (rhymes) { const dot = document.createElement('span'); dot.className = 'rhyme-dot'; chip.appendChild(dot) }
      chip.appendChild(document.createTextNode(syn))
      chip.onclick = () => insertWord(syn)
      synContainer.appendChild(chip)
    })
  }
}

function renderSongs(word, container) {
  container.innerHTML = ''
  const wordSig = getRhymeSignature(word)

  const rhymeSection = document.createElement('div')
  rhymeSection.className = 'drawer-section'
  const { perfect, near } = findRhymes(word)
  rhymeSection.innerHTML = `
    <div class="drawer-label">rhymes</div>
    <div class="rhyme-group"><div class="rhyme-group-label">perfect</div><div class="rhyme-chips" id="rc-songs-p"></div></div>
    <div class="rhyme-group"><div class="rhyme-group-label">near</div><div class="rhyme-chips" id="rc-songs-n"></div></div>`
  container.appendChild(rhymeSection)
  renderChips(document.getElementById('rc-songs-p'), perfect, true)
  renderChips(document.getElementById('rc-songs-n'), near, false)

  Object.values(SONGS_WORDS).forEach(group => {
    const section = document.createElement('div')
    section.className = 'drawer-section'

    const synChips = group.synonyms.map(w => {
      const sig = getRhymeSignature(w)
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
  const wordSig = getRhymeSignature(word)

  const rhymeSection = document.createElement('div')
  rhymeSection.className = 'drawer-section'
  const { perfect, near } = findRhymes(word)
  rhymeSection.innerHTML = `
    <div class="drawer-label">rhymes</div>
    <div class="rhyme-group"><div class="rhyme-group-label">perfect</div><div class="rhyme-chips" id="rc-scripture-p"></div></div>
    <div class="rhyme-group"><div class="rhyme-group-label">near</div><div class="rhyme-chips" id="rc-scripture-n"></div></div>`
  container.appendChild(rhymeSection)
  renderChips(document.getElementById('rc-scripture-p'), perfect, true)
  renderChips(document.getElementById('rc-scripture-n'), near, false)

  if (!bibleIndex) {
    const msg = document.createElement('div')
    msg.className = 'drawer-section'
    msg.innerHTML = '<div class="drawer-label">scripture</div><div class="drawer-loading">bible index not found</div>'
    container.appendChild(msg)
    return
  }

  const results = bibleIndex[word.toLowerCase()] || []
  const scriptSection = document.createElement('div')
  scriptSection.className = 'drawer-section'

  if (!results.length) {
    scriptSection.innerHTML = `<div class="drawer-label">scripture</div><div class="drawer-loading">"${word}" not found in WEB Bible</div>`
  } else {
    scriptSection.innerHTML = `<div class="drawer-label">scripture — ${results.length} occurrence${results.length !== 1 ? 's' : ''}</div>`
    results.slice(0, 8).forEach(v => {
      const row = document.createElement('div')
      row.className = 'verse-row'
      const highlighted = v.text.replace(
        new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'), 'gi'),
        m => `<mark>${m}</mark>`
      )
      row.innerHTML = `<div class="verse-ref">${v.ref}</div><div class="verse-text">${highlighted}</div>`
      row.onclick = () => insertWord(v.ref)
      scriptSection.appendChild(row)
    })
    if (results.length > 8) {
      const more = document.createElement('div')
      more.className = 'drawer-loading'
      more.style.marginTop = '6px'
      more.textContent = `+ ${results.length - 8} more occurrences`
      scriptSection.appendChild(more)
    }
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

function getCurrentLine() {
  const area = document.getElementById('idea-area')
  const text = area.value, pos = area.selectionStart
  const start = text.lastIndexOf('\n', pos-1) + 1
  const end = text.indexOf('\n', pos)
  return end === -1 ? text.slice(start) : text.slice(start, end)
}

function insertWord(word) {
  const area = document.getElementById('idea-area')
  const s = area.selectionStart, e = area.selectionEnd
  area.value = area.value.slice(0,s) + word + area.value.slice(e)
  area.selectionStart = area.selectionEnd = s + word.length
  area.focus(); autoSave()
}

// ── BULLET / TAB ──
function handleBullet(e) {
  if (e.key === 'Tab') {
    e.preventDefault()
    const area = e.target
    const pos = area.selectionStart
    const text = area.value
    const lineStart = text.lastIndexOf('\n', pos-1) + 1
    const lineEnd = text.indexOf('\n', pos)
    const end = lineEnd === -1 ? text.length : lineEnd
    const line = text.slice(lineStart, end)

    if (e.shiftKey) {
      // unindent
      if (line.startsWith('    ')) {
        area.value = text.slice(0, lineStart) + line.slice(4) + text.slice(end)
        area.selectionStart = area.selectionEnd = Math.max(lineStart, pos - 4)
      }
    } else {
      // indent
      area.value = text.slice(0, lineStart) + '    ' + line + text.slice(end)
      area.selectionStart = area.selectionEnd = pos + 4
    }
    autoSave()
    return
  }

  if (e.key === 'Enter') {
    const area = e.target
    const pos = area.selectionStart
    const text = area.value
    const lineStart = text.lastIndexOf('\n', pos-1) + 1
    const line = text.slice(lineStart, pos)

    // continue bullet •
    const bulletMatch = line.match(/^(\s*)(•)\s+/)
    if (bulletMatch) {
      // if line is empty bullet, break out
      if (line.trim() === '•') {
        e.preventDefault()
        area.value = text.slice(0, lineStart) + '\n' + text.slice(pos)
        area.selectionStart = area.selectionEnd = lineStart + 1
        autoSave()
        return
      }
      e.preventDefault()
      const indent = bulletMatch[1]
      const insert = '\n' + indent + '• '
      area.value = text.slice(0, pos) + insert + text.slice(pos)
      area.selectionStart = area.selectionEnd = pos + insert.length
      autoSave()
      return
    }

    // continue numbered list
    const numMatch = line.match(/^(\s*)(\d+)\.\s+/)
    if (numMatch) {
      if (line.trim() === numMatch[2] + '.') {
        e.preventDefault()
        area.value = text.slice(0, lineStart) + '\n' + text.slice(pos)
        area.selectionStart = area.selectionEnd = lineStart + 1
        autoSave()
        return
      }
      e.preventDefault()
      const indent = numMatch[1]
      const nextNum = parseInt(numMatch[2]) + 1
      const insert = '\n' + indent + nextNum + '. '
      area.value = text.slice(0, pos) + insert + text.slice(pos)
      area.selectionStart = area.selectionEnd = pos + insert.length
      autoSave()
      return
    }

    // continue dash list
    const dashMatch = line.match(/^(\s*)-\s+/)
    if (dashMatch) {
      if (line.trim() === '-') {
        e.preventDefault()
        area.value = text.slice(0, lineStart) + '\n' + text.slice(pos)
        area.selectionStart = area.selectionEnd = lineStart + 1
        autoSave()
        return
      }
      e.preventDefault()
      const indent = dashMatch[1]
      const insert = '\n' + indent + '- '
      area.value = text.slice(0, pos) + insert + text.slice(pos)
      area.selectionStart = area.selectionEnd = pos + insert.length
      autoSave()
      return
    }

    return
  }

  // dash-space → amber bullet
  if (e.key !== ' ') return
  const area = e.target
  const pos = area.selectionStart
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

// ── WIN MODE ──
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

// ── SEARCH / REMINDERS ──
function openSearch() { ipcRenderer.send('open-search') }
function openReminders() { ipcRenderer.send('open-reminders') }

function openLockIn() {
  const tab = tabs[currentTabIndex]
  if (!tab) return
  saveCurrentTab()

  if (tab.mode === 'plan') {
    // pass full plan tab data including phases and links
    const planTabs = tabs
      .map((t, i) => ({ title: t.title || 'untitled', filepath: t.filepath, index: i, mode: t.mode }))
      .filter(t => t.mode === 'plan')

    ipcRenderer.send('open-lockin-plan', {
      title: tab.title,
      filepath: tab.filepath,
      admin: tab.admin || document.getElementById('admin-area').value,
      planContext: tab.planContext || document.getElementById('plan-context-input').value,
      tasks: getTasksFromDOM(),
      phases: tab.phases || [],
      links: tab.links || [],
      planTabs
    })
  } else {
    ipcRenderer.send('open-lockin', {
      mode: tab.mode,
      content: document.getElementById('idea-area').value,
      title: tab.title,
      filepath: tab.filepath
    })
  }
}

function openLockInPlan() { openLockIn() }

function rescheduleReminders() {
  const allReminders = []
  const now = new Date()
  ;['write','plan'].forEach(mode => {
    const dir = mode === 'plan' ? PLAN_DIR : WRITE_DIR
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

// ── TAB SYSTEM ──
function emptyTab(mode) {
  return {
    filename: null, filepath: null, mode: mode || newTabMode,
    title: '', idea: '', context: '', tags: [],
    planContext: '', admin: '', tasks: [], phases: [], links: []
  }
}

function getDirForMode(mode) {
  if (mode === 'plan') return PLAN_DIR
  if (mode === 'project') return PROJECTS_DIR
  return WRITE_DIR
}

function getColorForMode(mode) {
  if (mode === 'plan') return '#4caf7d'
  if (mode === 'project') return '#7f77dd'
  if (mode === 'longform') return '#378add'
  return '#c8922a'
}

function saveCurrentTab() {
  if (!tabs[currentTabIndex]) return
  const tab = tabs[currentTabIndex]
  tab.title = document.getElementById('note-title').value || ''

  if (tab.mode === 'write') {
    tab.idea    = document.getElementById('idea-area').value
    tab.context = document.getElementById('context-area').value
    tab.tags    = currentTags()
  } else {
    tab.planContext = document.getElementById('plan-context-input').value
    tab.admin       = document.getElementById('admin-area').value
    tab.tasks       = getTasksFromDOM()
  }

  // write to disk
  if (tab.filepath) {
    try { fs.writeFileSync(tab.filepath, serializeTab(tab), 'utf8') } catch(e) {}
  }
}

function currentTags() {
  return Array.from(document.querySelectorAll('.tag')).map(t =>
    t.childNodes[0].textContent.trim()
  ).filter(Boolean)
}

function serializeTab(tab) {
  if (tab.mode === 'write' || tab.mode === 'longform') {
    return `# ${tab.title || 'untitled'}\ntype: ${tab.mode}\ntags: ${(tab.tags||[]).join(', ')}\n\n## idea\n${tab.idea || ''}\n\n## context\n${tab.context || ''}\n`
  } else {
    const planContext = tab.planContext || ''
    const admin = tab.admin || ''
    const tasks = tab.tasks || []
    const phases = tab.phases || []
    const links = tab.links || []

    let md = `# ${tab.title || 'untitled'}\ntype: plan\ncontext1: ${planContext}\n\n## admin\n${admin}\n\n## tasks\n`
    tasks.forEach(t => {
      md += `- [${t.done ? 'x' : ' '}] ${t.text}\n`
      if (t.reminder) md += `  reminder: ${t.reminder}\n`
    })

    md += `\n## phases\n`
    phases.forEach(phase => {
      md += `### ${phase.name}\n`
      if (phase.start) md += `start: ${phase.start}\n`
      if (phase.deadline) md += `deadline: ${phase.deadline}\n`
      phase.tasks.forEach(t => {
        md += `- [${t.done ? 'x' : ' '}] ${t.text}\n`
      })
    })

    md += `\n## links\n`
    links.forEach(l => { md += `- ${l}\n` })

    return md
  }
}

function loadTabIntoDOM(tab) {
  document.getElementById('note-title').value = tab.title || ''
  document.getElementById('note-meta').textContent = tab.filepath ? formatMeta(tab.filepath) : ''

  // show correct panel
  const isWriteLike = tab.mode === 'write' || tab.mode === 'longform'
  document.getElementById('panel-write').classList.toggle('active', isWriteLike)
  document.getElementById('panel-plan').classList.toggle('active', !isWriteLike)

  if (isWriteLike) {
    document.getElementById('idea-area').value = tab.idea || ''
    document.getElementById('context-area').value = tab.context || ''
    renderTagsFromArray(tab.tags || [])
    updateSyllableOverlay()
    setTimeout(() => document.getElementById('idea-area').focus(), 50)
  } else {
    document.getElementById('plan-context-input').value = tab.planContext || ''
    document.getElementById('admin-area').value = tab.admin || ''
    renderTasks(tab.tasks || [])
    setTimeout(() => document.getElementById('admin-area').focus(), 50)
  }
}

function switchTab(index) {
  if (index === currentTabIndex && tabs[index]) return
  saveCurrentTab()
  currentTabIndex = index
  loadTabIntoDOM(tabs[currentTabIndex])
  renderTabBar()
  saveTabPrefs()
}

function newTab() {
  saveCurrentTab()
  const tab = emptyTab(newTabMode)
  tabs.push(tab)
  currentTabIndex = tabs.length - 1
  createNoteFile(tab, () => {
    loadTabIntoDOM(tab)
    renderTabBar()
    saveTabPrefs()
    if (tab.mode !== 'longform') document.getElementById('note-title').focus()
  })
}

function closeTab(index) {
  if (tabs.length === 1) {
    // don't close last tab, just clear it
    saveCurrentTab()
    const tab = emptyTab(newTabMode)
    createNoteFile(tab)
    tabs[0] = tab
    currentTabIndex = 0
    loadTabIntoDOM(tab)
    renderTabBar()
    saveTabPrefs()
    return
  }

  saveCurrentTab()
  tabs.splice(index, 1)
  if (currentTabIndex >= tabs.length) currentTabIndex = tabs.length - 1
  loadTabIntoDOM(tabs[currentTabIndex])
  renderTabBar()
  saveTabPrefs()
}

function renderTabBar() {
  const bar = document.getElementById('tab-bar')
  const addBtn = document.getElementById('tab-add')
  bar.querySelectorAll('.tab').forEach(t => t.remove())

  tabs.filter(tab => tab.mode === newTabMode).forEach((tab, i) => {
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
    close.onclick = (e) => { e.stopPropagation(); closeTab(realIndex) }

    el.appendChild(dot)
    el.appendChild(title)
    el.appendChild(close)
   el.onclick = () => switchTab(realIndex)

    bar.insertBefore(el, addBtn)
  })

  // update mode toggle to reflect current tab
  const currentMode = tabs[currentTabIndex]?.mode || newTabMode
  ;['write','plan','project','longform'].forEach(m => {
    const btn = document.getElementById('btn-' + m)
    if (btn) btn.classList.toggle('active', m === currentMode)
  })}

function setNewTabMode(mode) {
  newTabMode = mode
  ;['write','plan'].forEach(m => {
    const btn = document.getElementById('btn-' + m)
    if (btn) btn.classList.toggle('active', m === mode)
  })

  // switch to most recent tab of this mode
  const modeTabIndex = tabs.reduce((found, tab, i) => {
    if (tab.mode === mode) return i
    return found
  }, -1)

  if (modeTabIndex !== -1) {
    switchTab(modeTabIndex)
  }

  renderTabBar()
}

function createNoteFile(tab, callback) {
  const dir = getDirForMode(tab.mode)
  const now = new Date()
  const stamp = now.toISOString().slice(0,16).replace('T','_').replace(':','-')
  const filename = `${stamp}.md`
  const filepath = path.join(dir, filename)
  tab.filename = filename
  tab.filepath = filepath
  tab.title = formatDateTitle(now)

  if (tab.mode === 'longform') {
    chooseLongformTemplate((key) => {
      const tmpl = getTemplateContent(key)
      if (tmpl.title) tab.title = tmpl.title
      tab.idea = tmpl.content
      const content = serializeTab(tab)
      try { fs.writeFileSync(filepath, content, 'utf8') } catch(e) {}
      if (callback) callback()
    })
  } else {
    const content = serializeTab(tab)
    try { fs.writeFileSync(filepath, content, 'utf8') } catch(e) {}
    if (callback) callback()
  }
}

// ── TAB PREFS ──
function saveTabPrefs() {
  try {
    const prefs = loadPrefs()
    prefs.tabs = tabs.map(t => ({ filename: t.filename, mode: t.mode, filepath: t.filepath }))
    prefs.currentTabIndex = currentTabIndex
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

// ── INIT ──
function init() {
  loadCMU()
  loadWordNet()
  loadBibleIndex()
  ensureDirs()
  

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
        const parsed = parseNote(raw, saved.mode)
        Object.assign(tab, parsed)
        tabs.push(tab)
      }
    })
  }

  if (tabs.length === 0) {
    // open latest write and plan notes as first two tabs
    const writeFiles = getNotesList('write')
    const planFiles  = getNotesList('plan')

    if (writeFiles.length > 0) {
      const tab = loadNoteAsTab(writeFiles[0], 'write')
      if (tab) tabs.push(tab)
    }
    if (planFiles.length > 0) {
      const tab = loadNoteAsTab(planFiles[0], 'plan')
      if (tab) tabs.push(tab)
    }
    if (tabs.length === 0) {
      const tab = emptyTab('write')
      createNoteFile(tab)
      tabs.push(tab)
    }
  }

  currentTabIndex = Math.min(prefs.currentTabIndex || 0, tabs.length - 1)
  loadTabIntoDOM(tabs[currentTabIndex])
  renderTabBar()
  bindKeys()
  bindSelection()

  ipcRenderer.on('reload-lockin-plan', (event, { index }) => {
    switchTab(index)
    openLockIn()
  })
ipcRenderer.on('drawer-lookup', (event, word) => {
  const clean = word.replace(/[^a-z]/gi,'').toLowerCase()
  if (clean.length < 2) return

  const { perfect, near } = findRhymes(clean)
  const sylCount = countSyllables(clean)

  // get scripture
  const scriptureResults = bibleIndex ? (bibleIndex[clean] || []).slice(0, 8) : []

  // get songs words matches
  const wordSig = getRhymeSignature(clean)
  const songsResults = Object.values(SONGS_WORDS).map(group => ({
    label: group.label,
    synonyms: group.synonyms.map(w => ({
      word: w,
      rhymes: wordSig && getRhymeSignature(w.split(' ')[0]) === wordSig
    })),
    expand: group.expand
  }))

  getSynonyms(clean).then(syns => {
    const synResults = syns.map(syn => ({
      word: syn,
      rhymes: wordSig && getRhymeSignature(syn.split(' ')[0]) === wordSig
    }))

    ipcRenderer.send('lockin-drawer-results', {
      word: clean,
      syllables: sylCount,
      rhymes: { perfect, near },
      synonyms: synResults,
      scripture: scriptureResults,
      songs: songsResults
    })
  })
})
  rescheduleReminders()

  ipcRenderer.on('load-note', (event, { filename, mode }) => {
    // open in a new tab
    saveCurrentTab()
    const tab = loadNoteAsTab(filename, mode)
    if (tab) {
      tabs.push(tab)
      currentTabIndex = tabs.length - 1
      loadTabIntoDOM(tab)
      renderTabBar()
      saveTabPrefs()
    }
  })

  ipcRenderer.on('new-note', (event, mode) => {
    newTabMode = mode
    newTab()
  })

  ipcRenderer.on('lockin-closed', (event, updatedContent) => {
    if (!updatedContent) return
    const tab = tabs[currentTabIndex]
    if (!tab) return
    if (tab.mode === 'write') {
      tab.idea = updatedContent
      document.getElementById('idea-area').value = updatedContent
      updateSyllableOverlay()
    } else {
      tab.admin = updatedContent
      document.getElementById('admin-area').value = updatedContent
    }
    autoSave()
  })

 ipcRenderer.on('lockin-plan-closed', (event, data) => {
    if (!data) return
    const tab = tabs[currentTabIndex]
    if (!tab || tab.mode !== 'plan') return

    // update tab with all data from Lock In
    tab.admin = data.admin || ''
    tab.planContext = data.planContext || ''
    tab.tasks = data.tasks || []
    tab.phases = data.phases || []
    tab.links = data.links || []

    // update DOM
    document.getElementById('admin-area').value = tab.admin
    document.getElementById('plan-context-input').value = tab.planContext
    renderTasks(tab.tasks)
    autoSave()
  })

  ipcRenderer.on('add-selection-as-task', (event, text) => {
    // find or create a plan tab
    let planTabIndex = tabs.findIndex(t => t.mode === 'plan')
    if (planTabIndex === -1) {
      saveCurrentTab()
      const tab = emptyTab('plan')
      createNoteFile(tab)
      tabs.push(tab)
      planTabIndex = tabs.length - 1
    }
    switchTab(planTabIndex)
    addTask(text, false, null)
    updateTaskCount()
    autoSave()
  })
}

function ensureDirs() {
  [NOTES_DIR, WRITE_DIR, PLAN_DIR, LONGFORM_DIR, PROJECTS_DIR].forEach(d => {
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
  const parsed = parseNote(raw, mode)
  Object.assign(tab, parsed)
  return tab
}

function parseNote(raw, mode) {
  const lines = raw.split('\n')
  let title='', idea='', context='', admin='', planContext=''
  let tags=[], tasks=[], phases=[], links=[], section='', currentPhase=null

  lines.forEach(line => {
    if (line.startsWith('# '))          { title = line.slice(2).trim(); return }
    if (line.startsWith('type: '))      { return }
    if (line.startsWith('tags: '))      { tags = line.slice(6).split(',').map(t=>t.trim()).filter(Boolean); return }
    if (line.startsWith('context1: ')) { planContext = line.slice(10); return }
    if (line === '## idea')             { section = 'idea'; return }
    if (line === '## context')          { section = 'context'; return }
    if (line === '## admin')            { section = 'admin'; return }
    if (line === '## tasks')            { section = 'tasks'; return }
    if (line === '## phases')           { section = 'phases'; return }
    if (line === '## links')            { section = 'links'; return }

    if      (section === 'idea')    idea    += (idea    ? '\n' : '') + line
    else if (section === 'context') context += (context ? '\n' : '') + line
    else if (section === 'admin')   admin   += (admin   ? '\n' : '') + line
    else if (section === 'tasks') {
      if (line.startsWith('- [x] '))      tasks.push({ text: line.slice(6), done: true,  reminder: null })
      else if (line.startsWith('- [ ] ')) tasks.push({ text: line.slice(6), done: false, reminder: null })
      else if (line.startsWith('  reminder: ') && tasks.length > 0)
        tasks[tasks.length-1].reminder = line.slice(12).trim()
    }
    else if (section === 'phases') {
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
    }
    else if (section === 'links') {
      if (line.startsWith('- ')) links.push(line.slice(2).trim())
    }
  })

  return { title, idea: idea.trim(), context: context.trim(), admin: admin.trim(), planContext, tags, tasks, phases, links }
}

function autoSave() {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveCurrentTab()
    const tab = tabs[currentTabIndex]
    if (tab?.filepath) {
      document.getElementById('note-meta').textContent = formatMeta(tab.filepath)
    }
    // update tab title in bar
    renderTabBar()
  }, 800)
}

function saveCurrentNote() { saveCurrentTab() }

function newNote() { newTab() }
function chooseLongformTemplate(callback) {
  const templates = [
    { key: 'blank', label: 'blank', desc: 'empty note' },
    { key: 'sermon', label: 'sermon', desc: 'scripture · big idea · points · application' },
    { key: 'essay', label: 'essay', desc: 'intro · argument · conclusion' },
    { key: 'study', label: 'bible study', desc: 'observe · interpret · apply · pray' }
  ]

  const picker = document.getElementById('template-picker')
  const options = document.getElementById('template-options')
  options.innerHTML = ''
  picker.style.display = 'flex'

  templates.forEach(t => {
    const btn = document.createElement('button')
    btn.style.cssText = `
      font-family: JetBrains Mono, monospace; font-size: 11px;
      padding: 10px 14px; border-radius: 6px;
      border: 0.5px solid var(--border2); color: var(--text2);
      background: var(--bg2); cursor: pointer; text-align: left;
      transition: all 0.12s; outline: none;
    `
    btn.onmouseenter = () => { btn.style.borderColor = 'var(--accent2)'; btn.style.color = 'var(--text)' }
    btn.onmouseleave = () => { btn.style.borderColor = 'var(--border2)'; btn.style.color = 'var(--text2)' }
    btn.innerHTML = `<div style="font-weight:500;color:var(--text);margin-bottom:3px;">${t.label}</div><div style="font-size:9px;color:var(--text3)">${t.desc}</div>`
    btn.onclick = () => {
      picker.style.display = 'none'
      callback(t.key)
    }
    options.appendChild(btn)
  })
}

function getTemplateContent(key) {
  const templates = {
    blank: { title: '', content: '' },
    sermon: {
      title: 'New Sermon',
      content: `# Series\n\n\n# Scripture\n\n\n# Big Idea\nOne sentence that captures everything.\n\n\n# Point 1\n\n\n# Point 2\n\n\n# Point 3\n\n\n# Illustration\n\n\n# Application\n\n\n# Call to Action`
    },
    essay: {
      title: 'New Essay',
      content: `# Introduction\n\n\n# Main Argument\n\n\n# Supporting Point 1\n\n\n# Supporting Point 2\n\n\n# Supporting Point 3\n\n\n# Conclusion`
    },
    study: {
      title: 'New Bible Study',
      content: `# Passage\n\n\n# Observation\nWhat does it say?\n\n\n# Interpretation\nWhat does it mean?\n\n\n# Application\nWhat do I do with it?\n\n\n# Prayer`
    }
  }
  return templates[key] || templates.blank
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

// ── TAGS ──
let tags = []

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
  const row = document.getElementById('tags-row')
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

// ── TASK EXTRACTION ──
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
  'message','meet','interview','follow','connect','invite',
  'coordinate','manage','lead','train','film','edit video',
  'export','render','caption','thumbnail','graphic','artwork',
  'budget','quote','invoice','deposit','payment', 'make', 'take', 
  'film', 'pay','get', 'ask', 'call', 'bring', 'go',
]

const TIME_WORDS = [
  'today','tomorrow','tonight','this week','next week',
  'monday','tuesday','wednesday','thursday','friday',
  'saturday','sunday','by end of','before','after',
  'jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'
]

function scoreSentence(s) {
  const lower = s.toLowerCase().trim()
  
  // bullet lines are always tasks
  if (s.trim().startsWith('•') || s.trim().startsWith('-')) return 10
  
  // >> flag is always a task
  if (s.trim().startsWith('>>')) return 10

  let score = 0

  // action word at START of sentence = high priority
  const firstWord = lower.split(' ')[0]
  const firstTwo = lower.split(' ').slice(0,2).join(' ')
  const imperatives = ['call','send','write','email','get','buy','fix','check','review',
    'schedule','book','contact','finish','complete','submit','update','order','record',
    'print','demo','prepare','add','promote','post','share','create','build','design',
    'launch','film','message','meet','finalize','draft','research','follow','invite',
    'confirm','deliver','print','edit','assign','coordinate','publish','request']
  
  if (imperatives.includes(firstWord)) score += 5
  if (['need to','have to','must','should','follow up','reach out'].includes(firstTwo)) score += 4

  return score
}

function extractTasks() {
  const text = document.getElementById('admin-area').value
  if (!text.trim()) return
  const existing = getTasksFromDOM().map(t => t.text.trim().toLowerCase())
  let added = 0
  text.split(/(?<=[.!?\n])/).map(s => s.trim()).filter(s => s.length > 4)
    .map(s => ({ text: s.replace(/^>>\s*/,'').trim(), score: scoreSentence(s) }))
    .filter(s => s.score >= 4 && s.text.length > 0 && !existing.includes(s.text.trim().toLowerCase()))
    .forEach(c => { addTask(c.text, false, null); added++ })
  if (added > 0) { updateTaskCount(); autoSave() }
  else {
    const empty = document.querySelector('.empty-tasks')
    if (empty) empty.textContent = 'no new tasks found — try >> to flag lines'
  }
}

// ── TASKS ──
function addTask(text, done=false, reminder=null) {
  const list = document.getElementById('task-list')
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

  actions.appendChild(dot)
  actions.appendChild(reminderBtn)
  actions.appendChild(reminderInfo)
  actions.appendChild(deleteBtn)
  body.appendChild(label)
  body.appendChild(actions)

  check.onclick = () => {
    check.classList.toggle('done')
    label.classList.toggle('done')
    updateTaskCount(); autoSave()
  }

  row.appendChild(check)
  row.appendChild(body)
  list.appendChild(row)
  updateTaskCount()
}

function renderTasks(tasks) {
  const list = document.getElementById('task-list')
  list.innerHTML = ''
  if (!tasks.length) {
    list.innerHTML = '<div class="empty-tasks">no tasks yet — hit extract below</div>'
    return
  }
  tasks.forEach(t => addTask(t.text, t.done, t.reminder))
  updateTaskCount()
}

function getTasksFromDOM() {
  return Array.from(document.querySelectorAll('.task-row')).map(row => ({
    text: row.querySelector('.task-text').textContent.trim(),
    done: row.querySelector('.task-check').classList.contains('done'),
    reminder: row.dataset.reminder || null
  }))
}

function updateTaskCount() {
  const total = document.querySelectorAll('.task-row').length
  const done  = document.querySelectorAll('.task-check.done').length
  document.getElementById('task-count').textContent = total > 0 ? `${done}/${total} done` : ''
}

// ── REMINDERS ──
function getNearest30() {
  const now = new Date()
  const d = new Date(now)
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

function closeReminder() {
  document.getElementById('reminder-popup').classList.remove('open')
}

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

// ── KEYBOARD ──
function bindKeys() {
  document.getElementById('idea-area').addEventListener('keydown', handleBullet)
  document.getElementById('admin-area').addEventListener('keydown', handleBullet)

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { closeDrawer(); closeReminder(); hideMarkdownHint() }
    if (e.key === 'f' && e.metaKey) { e.preventDefault(); openSearch() }
    if (e.key === 'r' && e.metaKey) { e.preventDefault(); openReminders() }
    if (e.key === 'b' && e.metaKey) { e.preventDefault(); fmtToggle('**') }
    if (e.key === 'i' && e.metaKey) { e.preventDefault(); fmtToggle('_') }
    if (e.key === 't' && e.metaKey) { e.preventDefault(); newTab() }

    if (e.key === 'Tab' && !['TEXTAREA','INPUT'].includes(document.activeElement.tagName)) {
      e.preventDefault()
      // cycle through tabs
      const next = (currentTabIndex + 1) % tabs.length
      switchTab(next)
    }

    if (e.key === 's' && e.metaKey) {
      e.preventDefault()
      saveCurrentTab()
      const meta = document.getElementById('note-meta')
      const tab = tabs[currentTabIndex]
      meta.textContent = 'saved ✓'
      setTimeout(() => { if (tab?.filepath) meta.textContent = formatMeta(tab.filepath) }, 1500)
    }

    if (e.key === 'n' && e.metaKey) { e.preventDefault(); newTab() }
  })

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

// ── SELECTION → DRAWER ──
function bindSelection() {
  document.getElementById('idea-area').addEventListener('mouseup', () => {
    setTimeout(() => {
      const sel = window.getSelection()?.toString().trim()
      if (sel && sel.length > 1 && !sel.includes(' ')) openDrawer(sel)
    }, 50)
  })
}

// ── START ──
init()