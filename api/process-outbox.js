// api/process-outbox.js
import { createClient } from '@supabase/supabase-js';
import { buildEmailContent } from '../email-template.js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY || null;
const TEAM_EMAILS = (process.env.TEAM_EMAILS || '').split(',').map(s => s.trim()).filter(Boolean);
const EMAIL_FROM = process.env.EMAIL_FROM || 'no-reply@example.com';

async function sendEmail({ to, subject, html, cc }) {
  if (!SENDGRID_API_KEY) {
    console.warn('SENDGRID_API_KEY not configured; skipping sendEmail');
    return { ok: true, skipped: true };
  }

  const personalizations = [{ to: Array.isArray(to) ? to.map(a => ({ email: a })) : [{ email: to }] }];
  if (cc && cc.length) personalizations[0].cc = cc.map(a => ({ email: a }));

  const body = {
    personalizations,
    from: { email: EMAIL_FROM },
    subject: subject,
    content: [{ type: 'text/html', value: html }]
  };

  const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${SENDGRID_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`SendGrid error ${res.status}: ${text}`);
  }

  return { ok: true };
}

// This endpoint is intended to be run as a scheduled function (cron) or invoked manually.
// It will process pending outbox jobs, attempt delivery via SendGrid (if configured),
// update lead rows, and mark jobs done or failed.
export default async function handler(req, res) {
  try {
    const now = new Date().toISOString();
    const { data: jobs, error } = await supabase
      .from('outbox_jobs')
      .select('*')
      .eq('status', 'pending')
      .lte('run_at', now)
      .limit(10);

    if (error) {
      console.error('Failed to fetch outbox jobs', error);
      return res.status(500).json({ error: String(error) });
    }

    if (!jobs || jobs.length === 0) {
      return res.status(200).json({ ok: true, processed: 0 });
    }

    let processed = 0;

    for (const job of jobs) {
      // Try to claim the job
      const { data: claimed, error: claimErr } = await supabase
        .from('outbox_jobs')
        .update({ status: 'in_progress' })
        .eq('id', job.id)
        .eq('status', 'pending')
        .select()
        .single();

      if (claimErr || !claimed) {
        // couldn't claim — skip
        continue;
      }

      try {
        if (job.type === 'email') {
          // Fetch lead to get email/name
          const { data: lead } = await supabase.from('leads').select('*').eq('id', job.lead_id).single();
          const payload = job.payload || {};
          const to = lead?.email ? [lead.email] : (payload.to || []);
          const { subject, html } = buildEmailContent({ name: lead?.name || payload.name || 'Participant', quizKey: lead?.quiz_key || payload.quizKey, bandKey: lead?.band_key || payload.bandKey, compositeScore: payload.compositeScore || lead?.composite_score || null });

          try {
            // send to lead and CC team if configured
            const cc = TEAM_EMAILS.length ? TEAM_EMAILS : undefined;
            await sendEmail({ to, subject, html, cc });

            // mark email as sent in leads
            if (lead) {
              await supabase.from('leads').update({ email_sent: true, email_error: null }).eq('id', lead.id);
            }
          } catch (sendErr) {
            console.error('Send failed for job', job.id, sendErr);
            await handleJobFailure(job, String(sendErr));
            continue;
          }
        } else if (job.type === 'constant_contact') {
          // placeholder for external integration
          await supabase.from('leads').update({ cc_synced: true, cc_sync_error: null }).eq('id', job.lead_id);
        } else if (job.type === 'alert') {
          console.log('ALERT:', job.payload && job.payload.message);
        }

        // mark job done
        await supabase.from('outbox_jobs').update({ status: 'done' }).eq('id', job.id);
      } catch (procErr) {
        console.error('Processing job failed', job.id, procErr);
        await handleJobFailure(job, String(procErr));
      } finally {
        processed++;
      }
    }

    return res.status(200).json({ ok: true, processed });
  } catch (err) {
    console.error('process-outbox top-level error', err);
    return res.status(500).json({ error: String(err) });
  }
}

async function handleJobFailure(job, lastError) {
  const attempts = (job.attempts || 0) + 1;
  const maxAttempts = 5;
  const nextRun = new Date(Date.now() + Math.pow(2, attempts) * 60 * 1000).toISOString();

  const updates = {
    attempts,
    last_error: lastError,
    run_at: attempts >= maxAttempts ? job.run_at : nextRun,
    status: attempts >= maxAttempts ? 'failed' : 'pending'
  };

  try {
    await supabase.from('outbox_jobs').update(updates).eq('id', job.id);
  } catch (e) {
    console.error('Failed to update outbox job after failure:', e);
  }

  if (attempts >= maxAttempts) {
    try {
      const leadUpdate = job.type === 'email' ? { email_error: lastError } : { cc_sync_error: lastError };
      await supabase.from('leads').update(leadUpdate).eq('id', job.lead_id);
      // queue an alert job
      await supabase.from('outbox_jobs').insert([{
        lead_id: job.lead_id,
        type: 'alert',
        payload: { message: `Permanent failure for job ${job.id}: ${lastError}` }
      }]);
    } catch (e) {
      console.error('Failed to mark lead or queue alert after permanent failure:', e);
    }
  }
}
