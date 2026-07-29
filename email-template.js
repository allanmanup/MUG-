// email-template.js
// Shared email content builder used by the outbox worker.
// Keeps content minimal for the prototype.

export function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function buildEmailContent({ name, quizKey, bandKey, compositeScore }) {
  const bandTitle = bandKey || 'Result';
  const subject = `${name}, here is your Man Up and Go result`;
  const html = `
    <p>Hi ${escapeHtml(name)},</p>
    <p>Your score: <strong>${escapeHtml(String(compositeScore))}%</strong></p>
    <h3>${escapeHtml(bandTitle)}</h3>
    <p>[Insert band title/body/verse/CTA from shared content module here]</p>
    <p>If you want to opt out of further emails, reply to this message.</p>
  `;
  return { subject, html };
}
