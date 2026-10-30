import { useState } from 'react';
import { toast } from 'sonner';
import { Button, CopyButton, Input, FormField, Modal } from '@/shared/ui';
import { apiErrorMessage } from '@/shared/api/errors';
import { activeEmployeeOptions } from '@/shared/api/picker-sources';
import { EntityPicker } from '@/shared/ui';
import { useDoorWrites } from './use-door';
import type { DoorCard, DoorTerminal, UnknownCardGroup } from './door.types';

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
        <div className="space-y-3 p-5">
          <p className="text-sm text-fg">
            Copy it now — opshub stores only its hash, so this is the last time it is ever shown.
          </p>
          <div className="flex items-start gap-2">
            <code className="block flex-1 overflow-x-auto rounded bg-surface-raised p-3 font-mono text-xs break-all text-fg">
              {token}
            </code>
            <CopyButton text={token} label="Copy token" />
          </div>
        </div>
      ) : (
        <div className="space-y-3 p-5">
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
  // Initialised FROM PROPS on mount — the caller keys this modal on the unknown-card UID (see
  // AssignUnknownCardModal), so a new row remounts with that row's UID (SA review B2: a preset
  // baked into the always-mounted modal's initial state never updated).
  const [uid, setUid] = useState(props.presetUid ?? '');
  const [label, setLabel] = useState('');
  const [validFrom, setValidFrom] = useState('');
  const [validUntil, setValidUntil] = useState('');
  const [busy, setBusy] = useState(false);

  function reset() {
    setEmployeeId('');
    setUid('');
    setLabel('');
    setValidFrom('');
    setValidUntil('');
  }

  async function submit() {
    setBusy(true);
    try {
      await createCard({
        employeeId,
        uid,
        label: label.trim() || null,
        validFrom: validFrom ? new Date(validFrom).toISOString() : undefined,
        validUntil: validUntil ? new Date(validUntil).toISOString() : null,
      });
      toast.success('Card enrolled');
      reset();
      props.onClose();
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
          <Button
            variant="ghost"
            onClick={() => {
              reset();
              props.onClose();
            }}
          >
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy || !employeeId || !uid.trim()}>
            {busy ? 'Enrolling…' : 'Enrol'}
          </Button>
        </>
      }
    >
      <div className="space-y-3 p-5">
        <FormField label="Employee" htmlFor="card-employee">
          {/* BY NAME, not by UUID (the EntityPicker docblock says why a UUID box never worked). */}
          <EntityPicker
            id="card-employee"
            queryKey="active-employees"
            value={employeeId}
            onChange={(v) => setEmployeeId(v)}
            fetchOptions={activeEmployeeOptions}
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
        <FormField label="Valid from (optional)" htmlFor="card-valid-from">
          <Input
            id="card-valid-from"
            type="datetime-local"
            value={validFrom}
            onChange={(e) => setValidFrom(e.target.value)}
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

/**
 * Enrol-from-reader: a UID the terminal saw and nobody owns, assigned to an employee. KEYED on the
 * event: switching rows remounts the form with the new UID instead of a stale one (SA review B2).
 */
export function AssignUnknownCardModal(props: {
  event: UnknownCardGroup | null;
  onClose: () => void;
}) {
  return (
    <AddCardModal
      key={props.event?.uid ?? 'adhoc'}
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
        <div className="flex items-start gap-2 p-5">
          <code className="block flex-1 overflow-x-auto rounded bg-surface-raised p-3 font-mono text-xs break-all text-fg">
            {token}
          </code>
          <CopyButton text={token} label="Copy token" />
        </div>
      ) : null}
    </Modal>
  );
}

/** Edit a live card: its label and (temporary) window. Status changes are separate actions. */
export function CardEditModal(props: { card: DoorCard | null; onClose: () => void }) {
  const { updateCard } = useDoorWrites();
  // Initialised from the row on mount; the caller keys this modal on the card id, so editing a
  // different card remounts the form.
  const [label, setLabel] = useState(props.card?.label ?? null);
  const [validUntil, setValidUntil] = useState(props.card?.validUntil?.slice(0, 16) ?? '');
  const [busy, setBusy] = useState(false);

  const card = props.card;

  async function submit() {
    if (!card) return;
    setBusy(true);
    try {
      // ONLY the fields the form edits — never a blanket PATCH (see the controller note in B1).
      await updateCard(card.id, {
        label: label ?? null,
        validUntil: validUntil ? new Date(validUntil).toISOString() : null,
      });
      toast.success('Card updated');
      props.onClose();
    } catch (err) {
      toast.error(apiErrorMessage(err, 'Failed to update the card.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={card !== null}
      onClose={props.onClose}
      title={`Edit card ${card?.uid ?? ''}`}
      footer={
        <>
          <Button variant="ghost" onClick={props.onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </Button>
        </>
      }
    >
      <div className="space-y-3 p-5">
        <FormField label="Label" htmlFor="edit-card-label">
          <Input
            id="edit-card-label"
            value={label ?? ''}
            onChange={(e) => setLabel(e.target.value)}
            maxLength={200}
          />
        </FormField>
        <FormField label="Valid until (empty = permanent)" htmlFor="edit-card-valid-until">
          <Input
            id="edit-card-valid-until"
            type="datetime-local"
            value={validUntil}
            onChange={(e) => setValidUntil(e.target.value)}
          />
        </FormField>
      </div>
    </Modal>
  );
}
