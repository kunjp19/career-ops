#!/usr/bin/env node

/**
 * Kunj end-to-end pipeline runner.
 *
 * This intentionally automates the mechanical path only:
 * - verifies source sync
 * - optionally runs the zero-token scanner
 * - processes pending URLs in data/pipeline.md
 * - extracts JDs from local cache or ATS APIs before using Playwright fallback
 * - scores/routes against Kunj's profile
 * - writes report + tracker TSV
 * - generates tailored PDFs only when enabled and above auto_pdf_score_threshold
 * - merges tracker additions and verifies pipeline health
 *
 * It never submits applications.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { execFileSync } from 'child_process';
import path from 'path';
import yaml from 'js-yaml';
import { chromium } from 'playwright';

const TODAY = new Date().toISOString().slice(0, 10);
const PROFILE_PATH = 'config/profile.yml';
const PIPELINE_PATH = 'data/pipeline.md';
const APPLICATIONS_PATH = 'data/applications.md';
const SCAN_HISTORY_PATH = 'data/scan-history.tsv';
const REPORTS_DIR = 'reports';
const OUTPUT_DIR = 'output';
const JDS_DIR = 'jds';
const TRACKER_ADDITIONS_DIR = 'batch/tracker-additions';
const KNOWLEDGE_BASE_PATH = 'data/job-knowledge-base.jsonl';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const skipScan = args.includes('--skip-scan');
const verifyScan = args.includes('--verify-scan');
const forcePdf = args.includes('--pdf');
const noPdf = args.includes('--no-pdf');
const noBrowser = args.includes('--no-browser') || args.includes('--cheap');
const refreshKnowledge = args.includes('--refresh-knowledge');
const limit = readNumberFlag('--limit', Infinity);

function readNumberFlag(name, fallback) {
  const idx = args.indexOf(name);
  if (idx === -1) return fallback;
  const value = Number(args[idx + 1]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function runNode(script, scriptArgs = []) {
  if (dryRun) {
    console.log(`[dry-run] node ${script} ${scriptArgs.join(' ')}`.trim());
    return '';
  }
  return execFileSync('node', [script, ...scriptArgs], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
}

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function ensureDirs() {
  for (const dir of [REPORTS_DIR, OUTPUT_DIR, JDS_DIR, TRACKER_ADDITIONS_DIR, 'data']) {
    mkdirSync(dir, { recursive: true });
  }
}

function loadProfile() {
  return yaml.load(readFileSync(PROFILE_PATH, 'utf8'));
}

function pendingItems() {
  if (!existsSync(PIPELINE_PATH)) return [];
  return readFileSync(PIPELINE_PATH, 'utf8')
    .split('\n')
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => /^- \[ \]\s+https?:\/\//.test(line))
    .map(({ line, index }) => {
      const body = line.replace(/^- \[ \]\s+/, '');
      const parts = body.split('|').map((part) => part.trim());
      return {
        index,
        raw: line,
        url: parts[0],
        companyHint: parts[1] || '',
        titleHint: parts[2] || '',
      };
    });
}

function nextReportNumber() {
  if (!existsSync(REPORTS_DIR)) return 1;
  const nums = execFileSync('bash', ['-lc', "find reports -maxdepth 1 -type f -name '[0-9][0-9][0-9]-*.md' -print"], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
    .map((file) => Number(path.basename(file).slice(0, 3)))
    .filter(Number.isFinite);
  return nums.length ? Math.max(...nums) + 1 : 1;
}

async function extractJob(item, browserFactory, knowledgeBase) {
  if (!refreshKnowledge && knowledgeBase.has(item.url)) {
    return { ...item, ...knowledgeBase.get(item.url), extractionMethod: 'local-knowledge-base' };
  }

  const apiJob = await extractJobViaApi(item).catch(() => null);
  if (apiJob?.text && apiJob.text.length > 500) {
    return { ...item, ...apiJob, extractionMethod: apiJob.extractionMethod || 'ats-api' };
  }

  if (noBrowser) {
    return {
      ...item,
      title: item.titleHint || 'Unknown role',
      company: item.companyHint || inferCompany(item.url, ''),
      text: `${item.companyHint || ''}\n${item.titleHint || ''}`.trim(),
      active: false,
      closed: false,
      extractionMethod: 'metadata-only-no-browser',
    };
  }

  const browser = await browserFactory();
  const page = await browser.newPage();
  try {
    await page.goto(item.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForTimeout(1200);
    const data = await page.evaluate(() => {
      const text = document.body?.innerText || '';
      const h1 = document.querySelector('h1')?.innerText?.trim() || '';
      const title = h1 || document.title || '';
      const apply = /\bapply\b/i.test(text) || !!document.querySelector('a[href*="apply"], button, input[type="submit"]');
      const closed = /no longer accepting|position has been filled|job not found|no longer available|the job you are looking for is no longer open/i.test(text);
      return { title, text, apply, closed };
    });
    return {
      ...item,
      title: item.titleHint || cleanTitle(data.title),
      company: item.companyHint || inferCompany(item.url, data.text),
      text: data.text,
      active: data.apply && !data.closed && data.text.length > 800,
      closed: data.closed,
      extractionMethod: 'playwright',
    };
  } finally {
    await page.close();
  }
}

async function extractJobViaApi(item) {
  const greenhouse = parseGreenhouseUrl(item.url);
  if (greenhouse) return extractGreenhouseJob(item, greenhouse);

  const lever = parseLeverUrl(item.url);
  if (lever) return extractLeverJob(item, lever);

  const ashby = parseAshbyUrl(item.url);
  if (ashby) return extractAshbyJob(item, ashby);

  return null;
}

function parseGreenhouseUrl(url) {
  const match = url.match(/job-boards(?:\.eu)?\.greenhouse\.io\/([^/]+)\/jobs\/(\d+)/);
  return match ? { board: match[1], id: match[2] } : null;
}

async function extractGreenhouseJob(item, { board, id }) {
  const apiUrl = `https://boards-api.greenhouse.io/v1/boards/${board}/jobs/${id}`;
  const json = await fetchJson(apiUrl);
  const content = htmlToText(json.content || '');
  const metadata = Array.isArray(json.metadata)
    ? json.metadata.map((m) => `${m.name}: ${formatMetadataValue(m.value)}`).join('\n')
    : '';
  const location = json.location?.name || '';
  const text = [
    json.title || item.titleHint,
    json.company_name || item.companyHint,
    location,
    metadata,
    content,
  ].filter(Boolean).join('\n\n');
  return {
    title: item.titleHint || json.title || '',
    company: item.companyHint || json.company_name || inferCompany(item.url, text),
    location,
    text,
    active: Boolean(json.absolute_url) && text.length > 500,
    closed: false,
    extractionMethod: 'greenhouse-api',
  };
}

function parseLeverUrl(url) {
  const match = url.match(/jobs\.lever\.co\/([^/]+)\/([a-f0-9-]+)/i);
  return match ? { company: match[1], id: match[2] } : null;
}

async function extractLeverJob(item, { company, id }) {
  const apiUrl = `https://api.lever.co/v0/postings/${company}/${id}`;
  const json = await fetchJson(apiUrl);
  const lists = Array.isArray(json.lists)
    ? json.lists.map((list) => `${list.text}\n${htmlToText(list.content || '')}`).join('\n\n')
    : '';
  const categories = json.categories || {};
  const location = categories.location || '';
  const text = [
    json.text || item.titleHint,
    item.companyHint,
    location,
    htmlToText(json.description || ''),
    htmlToText(json.descriptionPlain || ''),
    lists,
  ].filter(Boolean).join('\n\n');
  return {
    title: item.titleHint || json.text || '',
    company: item.companyHint || company,
    location,
    text,
    active: Boolean(json.hostedUrl || item.url) && text.length > 500,
    closed: false,
    extractionMethod: 'lever-api',
  };
}

function parseAshbyUrl(url) {
  const match = url.match(/jobs\.ashbyhq\.com\/([^/]+)\/([a-f0-9-]+)/i);
  return match ? { board: match[1], id: match[2] } : null;
}

async function extractAshbyJob(item, { board, id }) {
  const apiUrl = `https://api.ashbyhq.com/posting-api/job-board/${board}?includeCompensation=true`;
  const json = await fetchJson(apiUrl);
  const jobs = json.jobs || json.jobPostings || [];
  const job = jobs.find((entry) => entry.id === id || entry.jobId === id || entry.externalLink?.includes(id));
  if (!job) return null;
  const location = job.locationName || job.location || '';
  const text = [
    job.title || item.titleHint,
    item.companyHint || board,
    location,
    htmlToText(job.descriptionHtml || job.description || ''),
  ].filter(Boolean).join('\n\n');
  return {
    title: item.titleHint || job.title || '',
    company: item.companyHint || board,
    location,
    text,
    active: text.length > 500,
    closed: false,
    extractionMethod: 'ashby-api',
  };
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { accept: 'application/json', 'user-agent': 'career-ops-local-pipeline/1.0' },
  });
  if (!res.ok) throw new Error(`${url} returned HTTP ${res.status}`);
  return res.json();
}

function htmlToText(html) {
  return decodeHtmlEntities(String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|ul|ol|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim());
}

function decodeHtmlEntities(text) {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function formatMetadataValue(value) {
  if (Array.isArray(value)) return value.join(', ');
  if (value == null) return '';
  return String(value);
}

function cleanTitle(title) {
  return title
    .replace(/^Back to jobs\s+/i, '')
    .replace(/\s+-\s+.*$/, (match) => match.includes('Engineer') ? match : '')
    .trim();
}

function inferCompany(url, text) {
  if (/ashbyhq\.com\/([^/]+)/.test(url)) return RegExp.$1.replace(/[-_]/g, ' ');
  if (/lever\.co\/([^/]+)/.test(url)) return RegExp.$1.replace(/[-_]/g, ' ');
  const firstLine = text.split('\n').find(Boolean) || 'Unknown Company';
  return firstLine.split(' - ')[0].trim();
}

function scoreJob(job) {
  const text = `${job.company}\n${job.title}\n${job.text}`.toLowerCase();
  let score = 2.5;
  const hits = [];
  const gaps = [];

  const add = (cond, points, label) => {
    if (cond) { score += points; hits.push(label); }
  };
  const sub = (cond, points, label) => {
    if (cond) { score -= points; gaps.push(label); }
  };

  add(/java|spring boot|hibernate|jpa/.test(text), 0.7, 'Java/Spring/JPA match');
  add(/microservice|distributed|event-driven|messaging|kafka|jms|activemq|artemis/.test(text), 0.45, 'distributed/event-driven backend');
  add(/aws|docker|kubernetes|openshift|ci\/cd|jenkins|argocd|teamcity/.test(text), 0.4, 'cloud/CI/CD/platform overlap');
  add(/sql|postgres|mysql|oracle|database|schema|hibernate/.test(text), 0.3, 'SQL/database overlap');
  add(/test|junit|code review|mentor|maintainability|production|reliability/.test(text), 0.25, 'quality/mentoring/reliability');
  add(/remote|united states|usa|us remote/.test(text), 0.25, 'remote/US-compatible');
  add(/remote-first|remote first|remote workforce|work remotely/.test(text), 0.25, 'remote-first company/work model');
  add(/\baffirm\b/.test(text), 0.25, 'priority company: Affirm');
  add(/ai-assisted|claude code|codex|cursor|copilot|agentic/.test(text), 0.2, 'AI-assisted development relevance');

  sub(/staff/.test(text) && /10\+ years|8\+ years/.test(text) && !/java/.test(text), 0.5, 'staff scope without Java-first fit');
  sub(/10\+ years/.test(text), 0.25, '10+ years requested');
  sub(/go and python|strong proficiency in go and python|python \+ postgresql, go/.test(text), 0.35, 'Go/Python primary stack');
  sub(/spark|flink|airflow|dagster|snowflake|bigquery|redshift/.test(text) && !/spring boot/.test(text), 0.35, 'data-platform-heavy stack');
  sub(/san francisco office|in-office|in office|onsite|on-site/.test(text) && !/remote,? us|remote \(us\)|usa \(remote\)/.test(text), 0.85, 'onsite/location blocker');
  sub(/visa sponsorship/.test(text) && /require immigration support/.test(text), 0.1, 'authorization question present');

  score = Math.max(1, Math.min(5, Math.round(score * 10) / 10));
  const status = score >= 4.0 ? 'Evaluated' : 'SKIP';
  const action = score >= 4.5
    ? 'Apply now after reviewing tailored materials'
    : score >= 4.0
      ? 'Worth applying if no hidden blockers'
      : 'Skip or hold until proof points improve';
  return { score, status, hits, gaps, action };
}

function reportMarkdown(num, job, assessment, pdfNote) {
  const n = String(num).padStart(3, '0');
  const legitimacy = job.active ? 'High Confidence' : 'Proceed with Caution';
  const keywords = extractKeywords(job.text);
  return `# Evaluation: ${job.company} - ${job.title}

**Date:** ${TODAY}
**URL:** ${job.url}
**Archetype:** ${archetypeFor(job)}
**Score:** ${assessment.score.toFixed(1)}/5
**Legitimacy:** ${legitimacy}
**PDF:** ${pdfNote}

---

## A) Role Summary

${summaryFor(job)}

## B) Match with CV

**Strong matches**

${assessment.hits.map((hit) => `- ${hit}`).join('\n') || '- Limited direct match found.'}

**Gaps / risks**

${assessment.gaps.map((gap) => `- ${gap}`).join('\n') || '- No major obvious blocker detected by the local scorer.'}

## C) Level and Strategy

Score ${assessment.score.toFixed(1)}/5. ${assessment.action}.

Position Kunj through Java/Spring Boot microservices, event-driven integration, CI/CD automation, production debugging, code review, and mentoring. Avoid overstating technologies that are not in \`cv.md\`; use adjacent mapping only.

## D) Comp and Demand

Use the posted salary when present. For negotiation, compare against senior backend / cloud backend / data engineering market rates before quoting a number. If no range is visible, ask for range early and avoid underselling.

## E) Customization Plan

- Lead with Java/Spring Boot, event-driven services, CI/CD, and production reliability when those appear in the JD.
- Mention SQL tuning, schema design, and reporting/data integration for data-heavy roles.
- For Affirm or other remote-first companies, connect Kunj's remote-first preference to practical ownership, written communication, and production reliability.
- Add the AI-assisted Java quality lab proof point before applying to AI-assisted development roles.
- Generate a tailored PDF only for roles scoring at or above the configured threshold.

## F) Interview Plan

- NTT DATA: event-driven microservices with Java, Spring Boot, JMS, Apache Artemis, ActiveMQ.
- NTT DATA: coding standards, testing practices, code review, and mentoring.
- NTT DATA: OpenShift/Jenkins CI/CD and production debugging.
- Glint Logic: SQL query tuning, indexes, schema design, and production readiness.
- iLab: AI-driven risk system with 85% accuracy and deployment efficiency improvement.

## G) Posting Legitimacy

**Assessment:** ${legitimacy}

- Apply surface observed: ${job.active ? 'active' : 'not confirmed'}
- JD length: ${job.text.length} characters
- Description specificity: ${keywords.slice(0, 12).join(', ')}

## Recommendation

**${assessment.status === 'SKIP' ? 'SKIP / HOLD' : 'EVALUATE / APPLY'}:** ${assessment.action}.

---

## Keywords extracted

${keywords.join(', ')}
`;
}

function archetypeFor(job) {
  const text = `${job.title}\n${job.text}`.toLowerCase();
  if (/data engineer|data pipeline|airflow|spark|flink|warehouse/.test(text)) return 'Data Pipeline Engineer';
  if (/platform|kubernetes|terraform|argocd|cloud/.test(text)) return 'Cloud Backend Engineer / Platform Engineer';
  if (/java|spring/.test(text)) return 'Senior Backend Engineer / Java Spring Boot Engineer';
  return 'Senior Backend Engineer';
}

function summaryFor(job) {
  const lines = job.text.split('\n').map((line) => line.trim()).filter(Boolean);
  const location = lines.find((line) => /remote|united states|san francisco|location/i.test(line)) || 'Location not clearly parsed';
  return `**${job.company}** is hiring **${job.title}**. Parsed location/context: ${location}. The role appears to focus on ${archetypeFor(job).toLowerCase()} responsibilities.`;
}

function extractKeywords(text) {
  const candidates = [
    'Java', 'Spring Boot', 'Hibernate', 'JPA', 'SQL', 'Postgres', 'Kafka', 'JMS',
    'microservices', 'distributed systems', 'event-driven', 'AWS', 'Docker',
    'Kubernetes', 'OpenShift', 'ArgoCD', 'Terraform', 'CI/CD', 'Jenkins',
    'TeamCity', 'Datadog', 'Grafana', 'testing', 'JUnit', 'code reviews',
    'mentoring', 'production reliability', 'Python', 'Go', 'Airflow', 'Spark',
    'Flink', 'Snowflake', 'Redshift', 'BigQuery', 'AI-assisted development',
    'Claude Code', 'Codex', 'Cursor', 'agentic', 'remote-first', 'Affirm'
  ];
  const lower = text.toLowerCase();
  return candidates.filter((kw) => lower.includes(kw.toLowerCase())).slice(0, 28);
}

function tailoredResumeHtml(job) {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Kunjkumar Patel - ${escapeHtml(job.company)}</title>
<style>
@font-face{font-family:Space Grotesk;src:url('./fonts/space-grotesk-latin.woff2') format('woff2');font-weight:300 700}
@font-face{font-family:DM Sans;src:url('./fonts/dm-sans-latin.woff2') format('woff2');font-weight:100 1000}
*{box-sizing:border-box}body{font-family:"DM Sans",Arial,sans-serif;color:#1a1a2e;font-size:10px;line-height:1.32;margin:0;background:white}.page{max-width:8.5in;margin:0 auto}.header{margin-bottom:10px}.header h1{font-family:"Space Grotesk",Arial,sans-serif;font-size:24px;margin:0 0 4px}.line{height:2px;background:linear-gradient(to right,hsl(187,74%,32%),hsl(270,70%,45%));margin-bottom:6px}.contact{display:flex;flex-wrap:wrap;gap:8px;color:#555;font-size:9.5px}.section{margin-bottom:9px}.section h2{font-family:"Space Grotesk",Arial,sans-serif;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:hsl(187,74%,32%);border-bottom:1.5px solid #e2e2e2;padding-bottom:3px;margin:0 0 6px}.summary{font-size:10px;line-height:1.42}.tags{display:flex;flex-wrap:wrap;gap:5px}.tag{font-size:9px;color:hsl(187,74%,28%);background:hsl(187,40%,95%);border:1px solid hsl(187,40%,88%);border-radius:3px;padding:2px 7px}.job{margin-bottom:7px}.job-head{display:flex;justify-content:space-between;gap:12px}.company{font-family:"Space Grotesk";font-size:11px;font-weight:700;color:hsl(270,70%,45%)}.date{color:#777;white-space:nowrap}.role{font-weight:700;margin:1px 0 3px}ul{margin:3px 0 0 16px;padding:0}li{margin-bottom:1px}
</style></head><body><main class="page">
<section class="header"><h1>Kunjkumar Patel</h1><div class="line"></div><div class="contact"><span>Canton, MI</span><span>kunjp19@gmail.com</span><span>(234) 718-1833</span><span>linkedin.com/in/kunjp19</span><span>github.com/kunjp19</span><span>kunjp19.github.io</span></div></section>
<section class="section"><h2>Professional Summary</h2><p class="summary">Senior backend-focused software engineer with 5+ years of experience building Java/Spring Boot microservices, event-driven integration workflows, data pipelines, and cloud-native applications. Targeted for ${escapeHtml(job.company)}'s ${escapeHtml(job.title)} role through hands-on work with JMS, Apache Artemis, ActiveMQ, Spring Data JPA, SQL optimization, AWS, Docker, OpenShift, Jenkins, testing standards, code review, mentoring, and production debugging.</p></section>
<section class="section"><h2>Core Competencies</h2><div class="tags">${extractKeywords(job.text).slice(0, 10).map((kw) => `<span class="tag">${escapeHtml(kw)}</span>`).join('')}</div></section>
<section class="section"><h2>Work Experience</h2>
<div class="job"><div class="job-head"><div class="company">NTT DATA</div><div class="date">September 2021 - Present</div></div><div class="role">Senior Software Developer</div><ul><li>Design and develop event-driven Java/Spring Boot microservices using JMS, Apache Artemis, ActiveMQ, and enterprise integration patterns.</li><li>Automate CI/CD pipelines and cloud deployments with OpenShift and Jenkins, improving deployment efficiency and operational reliability.</li><li>Author and advocate team coding standards and testing best practices, improving maintainability and production readiness.</li><li>Lead code reviews, mentor junior developers, debug production issues, and deliver cross-application backend solutions.</li></ul></div>
<div class="job"><div class="job-head"><div class="company">Sikka Software Corporation</div><div class="date">July 2021 - September 2021</div></div><div class="role">Full-Stack Developer</div><ul><li>Enhanced KPI and reporting workflows, improving compatibility with practice management systems.</li><li>Integrated Sikka ONE API into cloud platforms across multiple data sources.</li><li>Migrated user interfaces to React.js, delivering responsive and WCAG-compliant applications.</li></ul></div>
<div class="job"><div class="job-head"><div class="company">iLab @ Computer Science, CSUEB</div><div class="date">May 2020 - May 2021</div></div><div class="role">Graduate Research Assistant</div><ul><li>Designed an AI-driven COVID-19 risk assessment system achieving 85% accuracy.</li><li>Enhanced backend architecture and documentation for troubleshooting and development workflows.</li><li>Deployed a crowd density estimation system using Firebase, Java, Python, and Flask, improving Android model deployment efficiency by 7%.</li></ul></div>
<div class="job"><div class="job-head"><div class="company">Glint Logic</div><div class="date">July 2017 - August 2019</div></div><div class="role">Software Engineer</div><ul><li>Built scalable full-stack applications with Spring Data JPA and React.js.</li><li>Optimized database performance by tuning SQL queries, adding indexes, and improving schema design.</li><li>Conducted impact analysis and validated unit tests against acceptance criteria.</li></ul></div>
</section>
<section class="section"><h2>Education & Certifications</h2><strong>Master of Science, Computer Science</strong> | August 2019 - May 2021<br><strong>Bachelor of Engineering, Computer Engineering</strong> | August 2015 - June 2019<ul><li>Continuous Delivery for Cloud Native Java Apps</li><li>AWS for Developers: RDS MySQL Database with Lambdas</li><li>AWS Developer Associate: Cloud Services</li></ul></section>
</main></body></html>`;
}

function writeTrackerAddition(num, job, assessment, pdfGenerated, reportPath) {
  const n = String(num).padStart(3, '0');
  const slug = slugify(job.company);
  const line = [
    num,
    TODAY,
    job.company,
    job.title,
    assessment.status,
    `${assessment.score.toFixed(1)}/5`,
    pdfGenerated ? '✅' : '❌',
    `[${n}](${reportPath})`,
    assessment.action,
  ].join('\t') + '\n';
  writeFileSync(`${TRACKER_ADDITIONS_DIR}/${n}-${slug}.tsv`, line, 'utf8');
}

function markProcessed(items) {
  let text = readFileSync(PIPELINE_PATH, 'utf8');
  const processedLines = [];
  for (const item of items) {
    text = text.replace(`${item.raw}\n`, '');
    text = text.replace(item.raw, '');
    processedLines.push(item.processedLine);
  }
  if (!text.includes('## Procesadas')) text += '\n## Procesadas\n';
  const insertAt = text.indexOf('## Procesadas') + '## Procesadas'.length;
  text = text.slice(0, insertAt) + '\n\n' + processedLines.join('\n') + text.slice(insertAt);
  writeFileSync(PIPELINE_PATH, text, 'utf8');
  sortPipelineProcessedByNumber();
}

function sortPipelineProcessedByNumber() {
  if (!existsSync(PIPELINE_PATH)) return;
  const text = readFileSync(PIPELINE_PATH, 'utf8');
  const marker = '## Procesadas';
  const markerIndex = text.indexOf(marker);
  if (markerIndex === -1) return;

  const before = text.slice(0, markerIndex + marker.length).replace(/\s+$/, '');
  const after = text.slice(markerIndex + marker.length);
  const processedLines = after
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^- \[x\] #\d+ \|/.test(line))
    .sort((a, b) => Number(a.match(/#(\d+)/)?.[1] || 0) - Number(b.match(/#(\d+)/)?.[1] || 0));

  writeFileSync(PIPELINE_PATH, `${before}\n\n${processedLines.join('\n')}\n`, 'utf8');
}

function sortApplicationsByNumber() {
  if (!existsSync(APPLICATIONS_PATH)) return;
  const text = readFileSync(APPLICATIONS_PATH, 'utf8');
  const lines = text.split('\n');
  const headerEnd = lines.findIndex((line) => line.startsWith('|---'));
  if (headerEnd === -1) return;
  const header = lines.slice(0, headerEnd + 1);
  const rows = lines
    .slice(headerEnd + 1)
    .filter((line) => /^\|\s*\d+\s*\|/.test(line))
    .sort((a, b) => Number(a.split('|')[1].trim()) - Number(b.split('|')[1].trim()));
  writeFileSync(APPLICATIONS_PATH, `${header.join('\n')}\n${rows.join('\n')}\n`, 'utf8');
}

function loadKnowledgeBase() {
  const entries = new Map();
  if (!existsSync(KNOWLEDGE_BASE_PATH)) return entries;
  for (const line of readFileSync(KNOWLEDGE_BASE_PATH, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry?.url && entry?.text) entries.set(entry.url, entry);
    } catch {
      // Ignore malformed local cache lines; future writes remain valid JSONL.
    }
  }
  return entries;
}

function rememberJob(job, assessment) {
  const entry = {
    url: job.url,
    title: job.title,
    company: job.company,
    location: job.location || '',
    active: job.active,
    closed: job.closed,
    extractionMethod: job.extractionMethod,
    score: assessment.score,
    status: assessment.status,
    cached_at: new Date().toISOString(),
    text: job.text,
  };
  appendFileSync(KNOWLEDGE_BASE_PATH, `${JSON.stringify(entry)}\n`, 'utf8');
}

async function main() {
  ensureDirs();
  console.log('== Kunj end-to-end pipeline ==');
  runNode('cv-sync-check.mjs');

  if (!skipScan) {
    const scanArgs = verifyScan ? ['--verify'] : [];
    console.log('Running zero-token scan...');
    const out = runNode('scan.mjs', scanArgs);
    if (out) console.log(out.trim());
  }

  const profile = loadProfile();
  const threshold = Number(profile.auto_pdf_score_threshold ?? 4.3);
  const pdfEnabled = forcePdf || (!noPdf && profile.pipeline?.auto_generate_pdf !== false);
  const knowledgeBase = loadKnowledgeBase();
  const pending = pendingItems().slice(0, limit);
  if (pending.length === 0) {
    console.log('No pending URLs found.');
    return;
  }

  let browser;
  const browserFactory = async () => {
    if (!browser) {
      console.log('Launching browser fallback for a job that has no cache/API extraction path...');
      browser = await chromium.launch({ headless: true });
    }
    return browser;
  };
  const processed = [];
  try {
    for (const item of pending) {
      const job = await extractJob(item, browserFactory, knowledgeBase);
      const assessment = scoreJob(job);
      const num = nextReportNumber();
      const n = String(num).padStart(3, '0');
      const companySlug = slugify(job.company);
      const roleSlug = slugify(job.title);
      const reportPath = `${REPORTS_DIR}/${n}-${companySlug}-${TODAY}.md`;
      const jdPath = `${JDS_DIR}/${companySlug}-${roleSlug}.txt`;
      const htmlPath = `${OUTPUT_DIR}/${companySlug}-${roleSlug}-resume.html`;
      const pdfPath = `${OUTPUT_DIR}/cv-kunjkumar-patel-${companySlug}-${roleSlug}-${TODAY}.pdf`;
      const pdfGenerated = pdfEnabled && assessment.score >= threshold && assessment.status !== 'SKIP';
      const pdfNote = pdfGenerated
        ? pdfPath
        : pdfEnabled
          ? 'not generated - below auto_pdf_score_threshold'
          : 'not generated - cheap/local mode; run with --pdf to generate';

      console.log(`#${n} ${job.company} | ${job.title} | ${assessment.score.toFixed(1)}/5 | ${assessment.status} | ${job.extractionMethod}`);
      if (!dryRun) {
        rememberJob(job, assessment);
        writeFileSync(jdPath, job.text, 'utf8');
        writeFileSync(reportPath, reportMarkdown(num, job, assessment, pdfNote), 'utf8');
        if (pdfGenerated) {
          writeFileSync(htmlPath, tailoredResumeHtml(job), 'utf8');
          runNode('generate-pdf.mjs', [htmlPath, pdfPath, '--format=letter']);
        }
        writeTrackerAddition(num, job, assessment, pdfGenerated, reportPath);
      }

      processed.push({
        raw: item.raw,
        processedLine: `- [x] #${n} | ${job.url} | ${job.company} | ${job.title} | ${assessment.score.toFixed(1)}/5 | PDF ${pdfGenerated ? '✅' : '❌'}`,
      });
    }
  } finally {
    if (browser) await browser.close();
  }

  if (!dryRun) {
    markProcessed(processed);
    runNode('merge-tracker.mjs');
    sortApplicationsByNumber();
    runNode('verify-pipeline.mjs');
  }

  console.log('Pipeline run complete.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
