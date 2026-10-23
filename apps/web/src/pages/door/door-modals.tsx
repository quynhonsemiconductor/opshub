import { useState } from 'react';
import { toast } from 'sonner';
import { Button, Input, FormField, Modal } from '@/shared/ui';
import { apiErrorMessage } from '@/shared/api/errors';
import { useDoorWrites } from './use-door';
import type { DoorTerminal, UnknownCardEvent } from './door.types';

/**
 * Register-terminal modal. The token is shown ONCE, in this dialog, with a copy button — the API
 * stores only its sha256, so dismissing the dialog without copying loses the credential and the
 * honest remedy is "regenerate" (which is why that action exists at all).
 */
export function RegisterTerminalModal(props: { open: boolean; onClose: () => void }) {
  const { createTerminal } = useDoorWrites();
  const [name, setName] = useState('');
  const [location, setLocation] = useState('');
  const [busy, setBusy] = useState(false);
  /** The revealed token. Held until the dialog closes; cleared on close. */
  const [token, setToken] = useState<string | null>(null);

  async function submit() {
    if (!name.trim()) return;
    setBusy(true);
    try {
      const { token: revealed } = await createTerminal({
        name: name.trim(),
        location: location.trim() || null,
      });
      setToken(revealed);
    } catch (err) {
      toast.error(apiErrorMessage(err, 'Failed to register the terminal.'));
    } finally {
      setBusy(false);
    }
  }

  function close() {
    setName('');
    setLocation('');
    setToken(null);
    props.onClose();
  }

  return (
    <Modal
      open={props.open}
      onClose={close}
      title={token ? 'Token shown once' : 'Register door terminal'}
      footer={
        token ? (
          <Button onClick={close}>I saved the token</Button>
        ) : (
          <>
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button onClick={submit} disabled={busy || !name.trim()}>
              {busy ? 'Registering…' : 'Register'}
            </Button>
          </>
        )
      }
    >
      {token ? (
        <div className="space-y-3">
          <p className="text-sm text-fg">
            Copy it now — opshub stores only its hash, so this is the last time it is ever shown.
          </p>
          <code className="block overflow-x-auto rounded bg-surface-raised p-3 font-mono text-xs break-all text-fg">
            {token}
          </code>
        </div>
      ) : (
        <div className="space-y-3">
          <FormField label="Name" htmlFor="terminal-name">
            <Input
              id="terminal-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Main door controller"
              maxLength={120}
            />
          </FormField>
          <FormField label="Location (optional)" htmlFor="terminal-location">
            <Input
              id="terminal-location"
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              placeholder="Lobby — inside"
              maxLength={200}
            />
          </FormField>
        </div>
      )}
    </Modal>
  );
}

/** Add-card modal. The UID is whatever the reader/box shows; the API normalises the separators. */
export function AddCardModal(props: { open: boolean; onClose: () => void; presetUid?: string }) {
  const { createCard } = useDoorWrites();
  const [employeeId, setEmployeeId] = useState('');
  const [uid, setUid] = useState(props.presetUid ?? '');
  const [label, setLabel] = useState('');
  const [validUntil, setValidUntil] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    try {
      await createCard({
        employeeId,
        uid,
        label: label.trim() || null,
        validUntil: validUntil ? new Date(validUntil).toISOString() : null,
      });
      toast.success('Card enrolled');
      props.onClose();
      setEmployeeId('');
      setUid('');
      setLabel('');
      setValidUntil('');
    } catch (err) {
      toast.error(apiErrorMessage(err, 'Failed to enrol the card.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={props.open}
      onClose={props.onClose}
      title="Enrol card"
      description="The employee must exist in the directory; paste the UID exactly as the reader shows it."
      footer={
        <>
          <Button variant="ghost" onClick={props.onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy || !employeeId || !uid.trim()}>
            {busy ? 'Enrolling…' : 'Enrol'}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <FormField label="Employee ID" htmlFor="card-employee">
          <Input
            id="card-employee"
            value={employeeId}
            onChange={(e) => setEmployeeId(e.target.value)}
            placeholder="Employee UUID from the People page"
          />
        </FormField>
        <FormField label="Card UID" htmlFor="card-uid">
          <Input
            id="card-uid"
            value={uid}
            onChange={(e) => setUid(e.target.value)}
            placeholder="04:A1:B2:C3"
          />
        </FormField>
        <FormField label="Label (optional)" htmlFor="card-label">
          <Input
            id="card-label"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            maxLength={200}
          />
        </FormField>
        <FormField label="Valid until (optional)" htmlFor="card-valid-until">
          <Input
            id="card-valid-until"
            type="datetime-local"
            value={validUntil}
            onChange={(e) => setValidUntil(e.target.value)}
          />
        </FormField>
      </div>
    </Modal>
  );
}

/** Enrol-from-reader: a UID the terminal saw and nobody owns, assigned to an employee. */
export function AssignUnknownCardModal(props: {
  event: UnknownCardEvent | null;
  onClose: () => void;
}) {
  return (
    <AddCardModal
      open={props.event !== null}
      onClose={props.onClose}
      presetUid={props.event?.uid}
    />
  );
}

/** Regenerate-token confirm → reveal. Same show-once contract as registration. */
export function RegenerateTokenModal(props: {
  terminal: DoorTerminal | null;
  onClose: () => void;
}) {
  const { regenerateTerminalToken } = useDoorWrites();
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function rotate() {
    if (!props.terminal) return;
    setBusy(true);
    try {
      const { token: revealed } = await regenerateTerminalToken(props.terminal.id);
      setToken(revealed);
    } catch (err) {
      toast.error(apiErrorMessage(err, 'Failed to regenerate the token.'));
    } finally {
      setBusy(false);
    }
  }

  function close() {
    setToken(null);
    props.onClose();
  }

  return (
    <Modal
      open={props.terminal !== null}
      onClose={close}
      title={
        token ? 'New token shown once' : `Regenerate token for “${props.terminal?.name ?? ''}”?`
      }
      description={
        token
          ? 'The old token stopped working the moment the new one was issued.'
          : 'The terminal must be re-provisioned with the new token over its serial console.'
      }
      footer={
        token ? (
          <Button onClick={close}>I saved the token</Button>
        ) : (
          <>
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button variant="danger" onClick={rotate} disabled={busy}>
              {busy ? 'Regenerating…' : 'Regenerate'}
            </Button>
          </>
        )
      }
    >
      {token ? (
        <code className="block overflow-x-auto rounded bg-surface-raised p-3 font-mono text-xs break-all text-fg">
          {token}
        </code>
      ) : null}
    </Modal>
  );
}
