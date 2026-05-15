// deno-lint-ignore-file
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import nodemailer from 'npm:nodemailer@6.9.14';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

async function sendEmail(smtp: Record<string, unknown>, mail: {
  to: string; toName?: string; subject: string; html: string; text: string;
}) {
  const transportConfig: any = {
    host: smtp.smtp_host,
    port: smtp.smtp_port,
    secure: smtp.smtp_port === 465,
    requireTLS: smtp.smtp_port === 587,
    tls: {
      rejectUnauthorized: true,
      minVersion: 'TLSv1.2',
    },
  };

  if (smtp.smtp_username && smtp.smtp_password) {
    transportConfig.auth = {
      user: smtp.smtp_username,
      pass: smtp.smtp_password,
    };
  }

  const transporter = nodemailer.createTransport(transportConfig);

  await transporter.sendMail({
    from: `"${smtp.smtp_from_name}" <${smtp.smtp_from_email}>`,
    to: mail.to,
    subject: mail.subject,
    html: mail.html,
    text: mail.text,
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ success: false, error: 'Unauthorized' }, 401);

    const adminClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    const userClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } }
    );

    const { data: { user }, error: authErr } = await userClient.auth.getUser();

    if (authErr || !user) {
      return json({ success: false, error: 'Unauthorized' }, 401);
    }

    const { data: config } = await adminClient
      .from('portal_config')
      .select('*')
      .eq('id', 1)
      .maybeSingle();

    const body = await req.json();

    // Test email mode
    if (body.test_email) {
      if (!config?.smtp_host || !config?.smtp_from_email) {
        return json({
          success: false,
          error: 'SMTP not configured. Save your SMTP settings in Settings first.',
        }, 400);
      }

      await sendEmail(config, {
        to: body.test_email,
        subject: 'FlowSentinel — SMTP Test',
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 500px;">
            <h2 style="color: #4F46E5;">FlowSentinel</h2>
            <p>This is a test email from your FlowSentinel Admin Portal.</p>
            <p>If you received this, your SMTP configuration is working correctly.</p>
            <p style="color: #888; font-size: 12px;">Sent at ${new Date().toISOString()}</p>
          </div>
        `,
        text: 'FlowSentinel SMTP test. If you received this, your SMTP configuration is working correctly.',
      });

      return json({ success: true });
    }

    // Reply mode
    const { ticket_id, reply_text, new_status } = body;

    if (!ticket_id) {
      return json({ success: false, error: 'ticket_id is required' }, 400);
    }

    const { data: ticket, error: ticketErr } = await adminClient
      .from('support_tickets')
      .select('*')
      .eq('id', ticket_id)
      .single();

    if (ticketErr || !ticket) {
      return json({ success: false, error: 'Ticket not found' }, 404);
    }

    const updates: Record<string, unknown> = {
      status: new_status || ticket.status,
      updated_at: new Date().toISOString(),
    };

    if (reply_text?.trim()) {
      updates.admin_reply = reply_text.trim();
      updates.replied_at = new Date().toISOString();
      updates.replied_by = user.email;
    }

    const { error: updateErr } = await adminClient
      .from('support_tickets')
      .update(updates)
      .eq('id', ticket_id);

    if (updateErr) {
      throw new Error(`Failed to update ticket: ${updateErr.message}`);
    }

    if (reply_text?.trim() && config?.smtp_host && config?.smtp_from_email) {
      const statusLabel = (new_status || ticket.status).replace('_', ' ');
      const recipientName = ticket.submitted_by_name || ticket.submitted_by_email.split('@')[0];
      const shortRef = ticket_id.slice(0, 8).toUpperCase();

      await sendEmail(config, {
        to: ticket.submitted_by_email,
        subject: `Re: [#${shortRef}] ${ticket.subject}`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <div style="background: #4F46E5; padding: 20px 24px; border-radius: 8px 8px 0 0;">
              <h2 style="color: white; margin: 0; font-size: 18px;">FlowSentinel Support</h2>
            </div>
            <div style="background: #ffffff; padding: 24px; border: 1px solid #e2e8f0; border-top: none; border-radius: 0 0 8px 8px;">
              <p style="color: #374151; margin-top: 0;">Hi ${recipientName},</p>
              <p style="color: #374151;">Here is our reply to your support ticket:</p>
              <div style="background: #f8fafc; border-left: 4px solid #4F46E5; padding: 16px; margin: 20px 0; border-radius: 0 4px 4px 0;">
                <p style="color: #1e293b; margin: 0; white-space: pre-wrap;">${reply_text.trim()}</p>
              </div>
              <p style="color: #6b7280; font-size: 14px;">
                Ticket status: <strong style="text-transform: capitalize;">${statusLabel}</strong>
              </p>
              <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 20px 0;" />
              <p style="color: #9ca3af; font-size: 12px; margin-bottom: 4px;"><strong>Subject:</strong> ${ticket.subject}</p>
              <p style="color: #9ca3af; font-size: 12px;"><strong>Reference:</strong> #${shortRef}</p>
              <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 20px 0;" />
              <p style="color: #9ca3af; font-size: 12px; margin: 0;">
                FlowSentinel — <a href="https://app.supportu.cloud">app.supportu.cloud</a>
              </p>
            </div>
          </div>
        `,
        text: `FlowSentinel Support\n\nHi ${recipientName}\n\n${reply_text.trim()}\n\nStatus: ${statusLabel}\nReference: #${shortRef}`,
      });

    } else if (reply_text?.trim()) {
      console.warn('Reply saved to DB but email not sent — SMTP not configured');
    }

    return json({ success: true });

  } catch (err) {
    console.error('send-ticket-reply error:', (err as Error).message);
    return json({ success: false, error: (err as Error).message }, 500);
  }
});