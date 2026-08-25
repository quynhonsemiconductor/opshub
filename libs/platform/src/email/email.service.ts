import { Inject, Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { EMAIL_PROVIDER, type IEmailProvider, type EmailSendResult } from './email.provider';
import { renderEmailTemplate, type EmailTemplateName, type EmailTemplateVars } from './templates';

/**
 * EmailService — render a typed template then dispatch via the injected provider.
 *
 * Usage inside a DB transaction: use EmailSchedulerService.schedule() instead.
 * Use this service directly only when the send must be immediate (e.g. test emails).
 */
@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  /**
   * `undefined` when no sender is configured, never a string containing "undefined".
   *
   * `MAIL_FROM_EMAIL` lost its default, because defaulting it made a misconfigured production send
   * from a domain it may not own. Interpolating the absent value would produce
   * `OpsHub <undefined>` — a syntactically valid header that fails at the recipient, which is the
   * same silent failure by a shorter route. The env schema refuses to boot a non-dev provider without
   * one, so this is only reachable under `dev`, where the provider logs and has nothing to send from.
   */
  private readonly from: string | undefined;
  /** Deployment-wide reply-to, from `MAIL_REPLY_TO`. Overridden per call by `opts.replyTo`. */
  private readonly replyTo: string | undefined;

  constructor(
    @Inject(EMAIL_PROVIDER) private readonly provider: IEmailProvider,
    config: AppConfigService,
  ) {
    const name = config.get('MAIL_FROM_NAME');
    const email = config.get('MAIL_FROM_EMAIL');
    this.from = email ? `${name} <${email}>` : undefined;
    /*
     * `MAIL_REPLY_TO` WAS DECLARED AND READ BY NOTHING.
     *
     * The env schema has had it since the mail config went in, `.env.example` lists it, the provider
     * interface carries `replyTo` and `sendTemplate` accepts it per call — and no caller ever passed one,
     * so the variable did nothing at all. An operator setting a reply-to address got mail with none, and
     * the reply went back to a `no-reply` sender.
     *
     * A DEFAULT, not an override: a caller that passes its own `replyTo` still wins, which is what the
     * per-call option is for. This only supplies the deployment-wide answer when nobody asked for a
     * different one.
     */
    this.replyTo = config.get('MAIL_REPLY_TO');
  }

  async sendTemplate<K extends EmailTemplateName>(
    to: string,
    template: K,
    vars: EmailTemplateVars[K],
    opts?: { replyTo?: string; idempotencyKey?: string },
  ): Promise<EmailSendResult> {
    const rendered = renderEmailTemplate(template, vars);
    try {
      // Returned so the relay can persist the provider's message id at acceptance —
      // that id is the feedback loop's only exact match key for a later verdict.
      return await this.provider.send({
        to,
        from: this.from,
        replyTo: opts?.replyTo ?? this.replyTo,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        category: 'transactional',
        idempotencyKey: opts?.idempotencyKey,
      });
    } catch (err) {
      // Log and re-throw — the relay will catch this and update the outbox row.
      this.logger.error({ err, to, template }, 'Failed to send email');
      throw err;
    }
  }
}
