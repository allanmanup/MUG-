// api/process-outbox.js
import { createClient } from '@supabase/supabase-js';
import { buildEmailContent } from '../email-template.js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// This endpoint is intended to be run as a scheduled function (cron) or invoked manually.
// For the prototype it will mark outbox jobs as done without sending real emails.
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
          // Build the email content (prototype)
          const payload = job.payload || {};
          const leadId = job.lead_id;
          // mark email as sent in leads (we pretend success)
          await supabase.from('leads').update({ email_sent: true, email_error: null }).eq('id', leadId);
        } else if (job.type === 'constant_contact') {
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
