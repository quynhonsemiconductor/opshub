import { Inject, Injectable, Logger } from '@nestjs/common';
import { DeferError } from '../outbox/abstract-outbox-relay';
import { AppConfigService } from '../config/app-config.service';
import {
  EMAIL_PROVIDER,
  EMAIL_SEND_TIMEOUT_MS,
  type IEmailProvider,
  type EmailSendResult,
} from './email.provider';
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
  /** Deployment-wide reply-to, from `MAIL_REPLY_TO`. Overridden per call by `opts.replyTo`. */
  private readonly replyTo: string | undefined;

  constructor(
    @Inject(EMAIL_PROVIDER) private readonly provider: IEmailProvider,
    config: AppConfigService,
  ) {
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

  /**
   * Fails now if the configured transport cannot work (the Graph provider names the missing variable). The worker calls this when its relay
   * starts, so a bad deploy stops there instead of dead-lettering the first invitation. A provider with nothing to check passes.
   */
  assertReady(): void {
    (this.provider as { assertReady?: () => void }).assertReady?.();
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
      return await withDeadline(
        (signal) =>
          this.provider.send(
            {
              to,
              replyTo: opts?.replyTo ?? this.replyTo,
              subject: rendered.subject,
              html: rendered.html,
              text: rendered.text,
              category: 'transactional',
              idempotencyKey: opts?.idempotencyKey,
            },
            { signal },
          ),
        EMAIL_SEND_TIMEOUT_MS,
      );
    } catch (err) {
      // Re-throw: the relay catches it and updates the outbox row. A DeferError is not a failure (the provider already logged the one block, and
      // every deferred row of a batch would repeat it); anything else is logged WITHOUT the recipient.
      if (!(err instanceof DeferError))
        this.logger.error({ err, template }, 'Failed to send email');
      throw err;
    }
  }
}

/**
 * Runs `work` with a hard deadline: at `ms` the SIGNAL passed to it is aborted (so a provider that can cancel stops the request, its in-place
 * retries and any wait: nothing is accepted after the caller has given up and the relay has retried), and the returned promise rejects even if
 * the provider ignores the signal.
 */
function withDeadline<T>(work: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`Email provider did not answer within ${Math.round(ms / 1000)} s`));
    }, ms);
  });
  return Promise.race([work(controller.signal), deadline]).finally(() => clearTimeout(timer));
}
