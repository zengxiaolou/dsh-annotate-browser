#!/usr/bin/env node
/**
 * 按 Conventional Commits 算下一个版本号（合并到 main 后由 Release 流水线调用）。
 *
 * 版本约定：本包还在 0.x，所以 feat / fix / perf 一律升补丁位；
 * 只有 BREAKING CHANGE（或 `feat!:`）才升中间位。
 * 没有可发版的提交就什么都不做（changed=false）。
 *
 * 用法：node .github/scripts/release.mjs [--notes-file <path>]
 * stdout 只输出 GITHUB_OUTPUT 用的 key=value；人类可读日志走 stderr。
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const argv = process.argv.slice(2)
/** --force：手动发一次补丁位（用于验证发布链路，或补一个纯版本提交） */
const forced = argv.includes('--force')
const notesFlag = argv.indexOf('--notes-file')
const notesPath = notesFlag >= 0 ? argv[notesFlag + 1] : null

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim()
const log = (...args) => console.error(...args)

function lastTag() {
  try {
    return git('describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*')
  } catch {
    return null
  }
}

function commitsSince(tag) {
  const range = tag ? `${tag}..HEAD` : 'HEAD'
  const raw = git('log', range, '--no-merges', '--format=%H%x1f%s%x1f%b%x1e')
  return raw
    .split('\x1e')
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const [hash, subject, body] = chunk.split('\x1f')
      return { hash: (hash || '').slice(0, 7), subject: (subject || '').trim(), body: (body || '').trim() }
    })
}

const TITLES = { feat: '新功能', fix: '修复', perf: '性能' }

function parseSubject(subject) {
  const matched = /^([a-z]+)(\([^)]*\))?(!)?:\s*(.+)$/i.exec(subject)
  if (!matched) return null
  return { type: matched[1].toLowerCase(), breaking: matched[3] === '!', summary: matched[4].trim() }
}

/** bump: 0=不发，1=补丁位，2=中间位 */
function plan(commits) {
  const groups = new Map()
  let bump = 0
  for (const commit of commits) {
    if (/^chore\(release\)/i.test(commit.subject)) continue
    const parsed = parseSubject(commit.subject)
    if (!parsed) continue
    const breaking = parsed.breaking || /BREAKING[ -]CHANGE/i.test(commit.body)
    const releasing = breaking || parsed.type === 'feat' || parsed.type === 'fix' || parsed.type === 'perf'
    if (!releasing) continue
    if (breaking) bump = 2
    else bump = Math.max(bump, 1)
    const key = breaking ? 'breaking' : parsed.type
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(commit)
  }
  return { bump, groups }
}

function nextVersion(current, bump) {
  const [major, minor, patch] = String(current).split('.').map((part) => Number.parseInt(part, 10) || 0)
  if (bump === 2) return `${major}.${minor + 1}.0`
  return `${major}.${minor}.${patch + 1}`
}

function renderNotes(version, groups) {
  const lines = [`## v${version}`, '']
  for (const key of ['breaking', 'feat', 'fix', 'perf']) {
    const list = groups.get(key)
    if (!list || list.length === 0) continue
    lines.push(`### ${key === 'breaking' ? '破坏性变更' : TITLES[key]}`, '')
    for (const commit of list) lines.push(`- ${commit.subject.replace(/^[^:]+:\s*/, '')} (${commit.hash})`)
    lines.push('')
  }
  return `${lines.join('\n').trim()}\n`
}

const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
const tag = lastTag()
const commits = commitsSince(tag)
const planned = plan(commits)
const groups = planned.groups
const bump = forced ? 1 : planned.bump
const changed = bump > 0
const version = changed ? nextVersion(pkg.version, bump) : pkg.version

if (notesPath) {
  const notes = changed ? renderNotes(version, groups) : ''
  writeFileSync(notesPath, notes.trim() === `## v${version}`.trim() ? `## v${version}\n\n手动发布（无代码变更，仅版本号）。\n` : notes)
}

log(`上一次 tag: ${tag ?? '(无)'}｜自那之后 ${commits.length} 条提交`)
log(changed ? `要发版: ${pkg.version} → ${version}（bump=${bump === 2 ? 'minor' : 'patch'}${forced ? '，手动强制' : ''}）` : '不发版：没有 feat / fix / perf 提交')

console.log(`changed=${changed}`)
console.log(`version=${version}`)
console.log(`tag=v${version}`)
console.log(`private=${pkg.private === true}`)
