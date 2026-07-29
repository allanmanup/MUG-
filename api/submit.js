import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Simple scoring and banding for prototype. Replace with your real rules later.
function computeScore(answers) {
  // answers: object { q1: number, q2: number, ... }
  const vals = Object.values(answers || {}).map(Number).filter(v => !Number.isNaN(v));
  if (vals.length === 0) return 0;
  const maxPer = 4; // assuming 0-4 scale
  const total = vals.reduce((a, b) => a + b, 0);
  const score = Math.round((total / (vals.length * maxPer)) * 100);
  return score;
}

function bandFromScore(score) {
  if (score >= 80) return 'Excellent';
  if (score >= 60) return 'Good';
  if (score >= 40) return 'AtRisk';
  return 'NeedsAttention';
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildReportHtml({ id, name, email, answers, score, band }) {
  return `<!doctype html>
  <html>
  <head>
    <meta charset="utf-8" />
    <title>Assessment Report</title>
    <style>body{font-family:Arial,Helvetica,sans-serif;max-width:800px;margin:24px}h1{color:#2b5797}</style>
  </head>
  <body>
    <h1>Assessment Report</h1>
    <p><strong>Participant:</strong> ${escapeHtml(name)} &lt;${escapeHtml(email)}&gt;</p>
    <p><strong>Date:</strong> ${new Date().toLocaleString()}</p>
    <h2>Score: ${score}%</h2>
    <h3>Band: ${band}</h3>
    <h3>Answers</h3>
    <ul>
      ${Object.entries(answers || {}).map(([q,a]) => `<li><strong>${escapeHtml(q)}:</strong> ${escapeHtml(String(a))}</li>`).join('')}
    </ul>
    <hr />
    <p>This is a prototype report. For production, reports are stored securely and emailed.</p>
  </body>
  </html>`;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const body = req.body || {};
  const { name, email, quizKey, answers } = body;

  if (!name || !email || !quizKey || !answers) {
    return res.status(400).json({ error: 'Missing required fields: name, email, quizKey, answers' });
  }

  try {
    const score = computeScore(answers);
    const band = bandFromScore(score);

    // 1) insert anonymous analytics row
    try {
      const { error: respErr } = await supabase.from('assessment_responses').insert({
        quiz_key: quizKey,
        composite_score: score,
        band_key: band,
        domain_scores: answers
      });
      if (respErr) console.error('assessment_responses insert error', respErr);
    } catch (e) {
      console.error('assessment_responses exception', e);
    }

    // 2) insert lead row (identifiable)
    let leadRow = null;
    try {
      const { data, error } = await supabase.from('leads').insert({
        quiz_key: quizKey,
        name,
        email,
        band_key: band
      }).select().single();
      if (error) {
        console.error('leads insert error', error);
      } else {
        leadRow = data;
      }
    } catch (e) {
      console.error('leads insert exception', e);
    }

    // 3) build immediate report HTML and return it so frontend can display
    const reportHtml = buildReportHtml({ id: leadRow ? leadRow.id : null, name, email, answers, score, band });

    return res.status(200).json({ ok: true, reportHtml });
  } catch (err) {
    console.error('submit error', err);
    return res.status(500).json({ error: 'Server error', details: String(err) });
  }
}
