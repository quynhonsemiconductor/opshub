import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Sparkles, SendHorizonal, RefreshCw, AlertCircle, Bot, User } from 'lucide-react';
import { cn } from '@/shared/lib/utils';
import { SlideOver } from '@/shared/ui/slide-over';
import { useAiChat, type ChatMessage } from './use-ai-chat';
import { Button } from '@/shared/ui';

// ── Suggestions ───────────────────────────────────────────────────────────────

const SUGGESTIONS = [
  'How many pending approval requests are there?',
  'Show me open compliance findings',
  'List active access grants for an employee',
  'What are the critical security findings?',
];

// ── Sub-components ────────────────────────────────────────────────────────────

function EmptyState({ onSuggest }: { onSuggest: (text: string) => void }) {
  return (
    <div className="flex flex-col items-center gap-6 px-6 py-10 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-accent/10">
        <Sparkles className="h-6 w-6 text-accent" strokeWidth={1.75} />
      </div>
      <div>
        <p className="text-sm font-medium text-fg">OpsHub AI Assistant</p>
        <p className="mt-1 text-xs text-fg-muted">
          Ask about requests, compliance findings, employees, and access grants.
        </p>
      </div>
      <div className="flex w-full flex-col gap-2">
        {SUGGESTIONS.map((s) => (
          <Button
            key={s}
            variant="outline"
            onClick={() => onSuggest(s)}
            className="h-auto justify-start bg-surface-muted px-4 py-2.5 text-left text-xs hover:border-accent/40 hover:bg-surface"
          >
            {s}
          </Button>
        ))}
      </div>
    </div>
  );
}

function MessageBubble({ msg }: { msg: ChatMessage }) {
  const isUser = msg.role === 'user';
  return (
    <div className={cn('flex animate-fade-up items-start gap-2.5', isUser && 'flex-row-reverse')}>
      {/* Avatar */}
      <div
        className={cn(
          'mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full',
          isUser ? 'bg-accent text-white' : 'bg-surface-muted text-fg-muted ring-1 ring-border',
        )}
      >
        {isUser ? (
          <User className="h-3.5 w-3.5" strokeWidth={2} />
        ) : (
          <Bot className="h-3.5 w-3.5" strokeWidth={2} />
        )}
      </div>

      {/* Bubble */}
      <div
        className={cn(
          'max-w-[84%] rounded-xl px-3.5 py-2.5 text-sm leading-relaxed',
          isUser ? 'bg-accent text-white' : 'bg-surface-muted text-fg ring-1 ring-border',
        )}
      >
        {msg.content.split('\n').map((line, i) => (
          <span key={i}>
            {line}
            {i < msg.content.split('\n').length - 1 && <br />}
          </span>
        ))}
      </div>
    </div>
  );
}

function TypingIndicator() {
  return (
    <div className="flex items-start gap-2.5">
      <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-surface-muted text-fg-muted ring-1 ring-border">
        <Bot className="h-3.5 w-3.5" strokeWidth={2} />
      </div>
      <div className="flex items-center gap-1 rounded-xl bg-surface-muted px-3.5 py-3 ring-1 ring-border">
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-fg-subtle [animation-delay:0ms]" />
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-fg-subtle [animation-delay:150ms]" />
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-fg-subtle [animation-delay:300ms]" />
      </div>
    </div>
  );
}

// ── Main panel ────────────────────────────────────────────────────────────────

interface AiChatPanelProps {
  open: boolean;
  onClose: () => void;
}

export function AiChatPanel({ open, onClose }: AiChatPanelProps) {
  const { messages, isPending, error, send, clear } = useAiChat();
  const [draft, setDraft] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-scroll to latest message
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isPending]);

  // Focus input on open
  useEffect(() => {
    if (open) {
      setTimeout(() => textareaRef.current?.focus(), 150);
    }
  }, [open]);

  async function handleSend() {
    if (!draft.trim() || isPending) return;
    const text = draft;
    setDraft('');
    await send(text);
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    void handleSend();
  }

  const headerActions =
    messages.length > 0 ? (
      <button
        type="button"
        onClick={clear}
        title="Clear conversation"
        aria-label="Clear conversation"
        className="flex h-7 w-7 items-center justify-center rounded-md text-fg-subtle transition-colors hover:bg-surface-hover hover:text-fg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      >
        <RefreshCw className="h-3.5 w-3.5" strokeWidth={2} />
      </button>
    ) : undefined;

  return (
    <SlideOver
      open={open}
      onClose={onClose}
      title="AI Assistant"
      description="Powered by Claude · Enterprise mode"
      width="lg"
      headerActions={headerActions}
      footer={
        <form onSubmit={handleSubmit} className="flex items-end gap-2">
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={handleKeyDown}
            rows={1}
            placeholder="Ask anything about your operations…"
            aria-label="Chat message"
            disabled={isPending}
            className={cn(
              'flex-1 resize-none rounded-lg border border-border bg-surface-muted px-3 py-2',
              'text-sm text-fg placeholder:text-fg-subtle',
              'transition-colors focus:border-accent/60 focus:outline-none focus:ring-2 focus:ring-accent/20',
              'disabled:opacity-50',
              'max-h-32 min-h-[36px]',
            )}
            style={{ height: Math.min(128, 36 + (draft.split('\n').length - 1) * 20) + 'px' }}
          />
          <button
            type="submit"
            disabled={!draft.trim() || isPending}
            aria-label="Send message"
            className={cn(
              'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition-colors',
              'bg-accent text-white hover:bg-accent/90',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
              'disabled:cursor-not-allowed disabled:opacity-40',
            )}
          >
            <SendHorizonal className="h-4 w-4" strokeWidth={2} />
          </button>
        </form>
      }
    >
      {/* Message area */}
      <div className="flex flex-col gap-4 px-5 py-4">
        {messages.length === 0 && !isPending ? (
          <EmptyState
            onSuggest={(text) => {
              setDraft(text);
              textareaRef.current?.focus();
            }}
          />
        ) : (
          messages.map((msg, i) => <MessageBubble key={i} msg={msg} />)
        )}

        {isPending && <TypingIndicator />}

        {error && (
          <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3.5 py-3 text-sm dark:border-red-900/40 dark:bg-red-950/30">
            <AlertCircle
              className="mt-0.5 h-4 w-4 shrink-0 text-red-500 dark:text-red-400"
              strokeWidth={2}
            />
            <p className="text-red-700 dark:text-red-300">{error}</p>
          </div>
        )}

        <div ref={bottomRef} />
      </div>
    </SlideOver>
  );
}
