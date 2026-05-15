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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const { name, company, email, mailboxes, message } = await req.json();

    if (!name || !email || !company) {
      return json({ success: false, error: 'Name, company and email are required' }, 400);
    }

    // Load SMTP config from portal_config
    const adminClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    const { data: config } = await adminClient
      .from('portal_config')
      .select('*')
      .eq('id', 1)
      .maybeSingle();

    if (!config?.smtp_host || !config?.smtp_from_email) {
      return json({
        success: false,
        error: 'Email service not configured. Please contact us directly.',
      }, 500);
    }

    // Build transporter
    const transportConfig: any = {
      host: config.smtp_host,
      port: config.smtp_port,
      secure: config.smtp_port === 465,
      requireTLS: config.smtp_port === 587,
      tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' },
    };

    if (config.smtp_username && config.smtp_password) {
      transportConfig.auth = {
        user: config.smtp_username,
        pass: config.smtp_password,
      };
    }

    const transporter = nodemailer.createTransport(transportConfig);

    // Email to YOU (the sales enquiry notification)
    await transporter.sendMail({
      from: `"${config.smtp_from_name}" <${config.smtp_from_email}>`,
      to: config.smtp_from_email, // send to yourself
      replyTo: email,             // reply goes to the prospect
      subject: `FlowSentinel Demo Request — ${company}`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px;">
          <div style="background: #4F46E5; padding: 20px 24px; border-radius: 8px 8px 0 0;">
            <h2 style="color: white; margin: 0;">New Demo Request</h2>
          </div>
          <div style="background: #ffffff; padding: 24px; border: 1px solid #e2e8f0; border-top: none; border-radius: 0 0 8px 8px;">
            <table style="width: 100%; border-collapse: collapse;">
              <tr><td style="padding: 8px 0; color: #6b7280; width: 140px;">Name</td><td style="padding: 8px 0; color: #111827; font-weight: 500;">${name}</td></tr>
              <tr><td style="padding: 8px 0; color: #6b7280;">Company</td><td style="padding: 8px 0; color: #111827; font-weight: 500;">${company}</td></tr>
              <tr><td style="padding: 8px 0; color: #6b7280;">Email</td><td style="padding: 8px 0;"><a href="mailto:${email}" style="color: #4F46E5;">${email}</a></td></tr>
              <tr><td style="padding: 8px 0; color: #6b7280;">Mailboxes</td><td style="padding: 8px 0; color: #111827;">${mailboxes || 'Not specified'}</td></tr>
            </table>
            ${message ? `
            <div style="margin-top: 16px; padding: 16px; background: #f8fafc; border-radius: 8px; border-left: 4px solid #4F46E5;">
              <p style="margin: 0; color: #374151; white-space: pre-wrap;">${message}</p>
            </div>` : ''}
            <div style="margin-top: 24px; padding-top: 16px; border-top: 1px solid #e2e8f0;">
              <p style="margin: 0; color: #9ca3af; font-size: 12px;">
                Submitted via supportu.cloud at ${new Date().toLocaleString('en-GB', { timeZone: 'Asia/Kolkata' })} IST
              </p>
            </div>
          </div>
        </div>
      `,
      text: `New Demo Request\n\nName: ${name}\nCompany: ${company}\nEmail: ${email}\nMailboxes: ${mailboxes || 'Not specified'}\n\nMessage:\n${message || 'None'}`,
    });

    // Auto-reply to the prospect
    await transporter.sendMail({
      from: `"${config.smtp_from_name}" <${config.smtp_from_email}>`,
      to: email,
      subject: `Thank you for your interest in FlowSentinel`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px;">
          <div style="background: #4F46E5; padding: 20px 24px; border-radius: 8px 8px 0 0;">
            <h2 style="color: white; margin: 0;">FlowSentinel</h2>
          </div>
          <div style="background: #ffffff; padding: 24px; border: 1px solid #e2e8f0; border-top: none; border-radius: 0 0 8px 8px;">
            <p style="color: #374151;">Hi ${name},</p>
            <p style="color: #374151;">
              Thank you for your interest in FlowSentinel. We have received your demo request
              and will be in touch within one business day.
            </p>
            <p style="color: #374151;">
              In the meantime, feel free to reply to this email if you have any questions.
            </p>
            <p style="color: #374151;">Best regards,<br/>The FlowSentinel Team</p>
            <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 20px 0;" />
            <p style="color: #9ca3af; font-size: 12px; margin: 0;">
              FlowSentinel — Intelligent Workflow Continuity Monitor<br/>
              <a href="https://supportu.cloud" style="color: #4F46E5;">supportu.cloud</a>
            </p>
          </div>
        </div>
      `,
      text: `Hi ${name},\n\nThank you for your interest in FlowSentinel. We have received your demo request and will be in touch within one business day.\n\nBest regards,\nThe FlowSentinel Team`,
    });

    return json({ success: true });

  } catch (err) {
    console.error('send-contact-email error:', (err as Error).message);
    return json({ success: false, error: (err as Error).message }, 500);
  }
});