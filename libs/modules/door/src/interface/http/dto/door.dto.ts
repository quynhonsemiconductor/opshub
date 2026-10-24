import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { PaginationQuerySchema } from '@shared-kernel';
import { doorCardStatusEnum } from '@db/schema/enums';

/**
 * The UID a reader (or an HR person with the card in hand) reports. Normalisation to storage shape
 * (uppercase hex, no separators) is the SERVICE's job — normalising in the schema would let a
 * caller think `04:a1-b2c3` is a distinct identity from `04A1B2C3`.
 */
/**
 * VALIDATED AFTER STRIPPING SEPARATORS (SA review B3): a 10-byte UID written with separators is 29
 * characters, and a raw `.max(20)` would refuse it before the service ever normalised. What comes
 * OUT of the schema is already storage shape — the service's normalise stays as the idempotent
 * backstop for direct callers.
 */
export const CardUidSchema = z
  .string()
  .transform((v) => v.replace(/[\s:.-]/g, '').toUpperCase())
  .pipe(
    z
      .string()
      .regex(/^[0-9A-F]{8}([0-9A-F]{6}){0,2}$/, 'Not a 4/7/10-byte UID (hex, optional separators)'),
  );

export const CreateTerminalSchema = z.object({
  name: z.string().trim().min(1).max(120),
  location: z.string().trim().max(200).nullable().optional(),
});
export class CreateTerminalDto extends createZodDto(CreateTerminalSchema) {}

export const CreateCardSchema = z.object({
  employeeId: z.string().uuid(),
  uid: CardUidSchema,
  label: z.string().trim().max(200).nullable().optional(),
  validFrom: z.string().datetime({ offset: true }).optional(),
  validUntil: z.string().datetime({ offset: true }).nullable().optional(),
});
export class CreateCardDto extends createZodDto(CreateCardSchema) {}

export const UpdateCardSchema = z
  .object({
    label: z.string().trim().max(200).nullable().optional(),
    // Only the two closing statuses are writable; a card comes back by REISSUE, not un-revocation.
    status: z.enum(['revoked', 'lost']).optional(),
    validFrom: z.string().datetime({ offset: true }).optional(),
    validUntil: z.string().datetime({ offset: true }).nullable().optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: 'No fields to update',
  });
export class UpdateCardDto extends createZodDto(UpdateCardSchema) {}

export const ListCardsQuerySchema = z
  .object({
    status: z.enum(doorCardStatusEnum.enumValues).optional(),
    employeeId: z.string().uuid().optional(),
  })
  .merge(PaginationQuerySchema);
export class ListCardsQueryDto extends createZodDto(ListCardsQuerySchema) {}

export class DoorTerminalResponseDto {
  id!: string;
  name!: string;
  location!: string | null;
  /** Set once a terminal has talked to us; the Healthchecks job keys on it. */
  lastSeenAt!: string | null;
  revokedAt!: string | null;
  droppedEvents!: number;
  createdAt!: string;
  updatedAt!: string;
}

/** The ONLY response that ever carries a token — create and regenerate, never a read. */
export class DoorTerminalTokenResponseDto {
  terminal!: DoorTerminalResponseDto;
  token!: string;
}

export class DoorCardResponseDto {
  id!: string;
  employeeId!: string;
  employeeName!: string | null;
  uid!: string;
  label!: string | null;
  status!: string;
  validFrom!: string;
  validUntil!: string | null;
  revokedAt!: string | null;
  createdAt!: string;
  updatedAt!: string;
}

export class UnknownCardGroupResponseDto {
  uid!: string;
  /** Reader of the most recent unknown swipe on this UID. */
  reader!: string;
  /** How many times the readers saw it in the window. */
  count!: number;
  lastSeenAt!: string;
}
