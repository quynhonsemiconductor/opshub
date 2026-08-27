import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Put } from '@nestjs/common';
import { ApiTags, ApiOkResponse, ApiNoContentResponse } from '@nestjs/swagger';
import {
  ApiCommonErrors,
  Auth,
  CurrentUser,
  ErrorCodes,
  GLOBAL_PREFERENCE_TYPE,
  NOTIFICATION_TEMPLATE_NAMES,
  ValidationException,
  type JwtPayload,
  SelfScoped,
} from '@platform';
import { NotificationPreferencesService } from '../../application/notification-preferences.service';
import { UpsertPreferenceDto } from './dto/preference-request.dto';
import { PreferenceResponseDto } from './dto/preference-response.dto';

/**
 * Refuses a preference for an event that does not exist.
 *
 * The route took `@Param('type') type: string` and stored whatever arrived, so the settings screen's
 * thirteen toggles for events with no template each wrote a row that nothing would ever read — a
 * preference the user had every reason to think was in force. Storing it was the part that made the
 * screen convincing.
 *
 * 422 rather than 404: the request is well-formed and the route exists, it is the BODY of the request
 * — which event this is about — that cannot be honoured. And validated here rather than in a DTO
 * because the value is a path parameter, which `UpsertPreferenceDto` does not see.
 */
function assertKnownPreferenceType(type: string): void {
  if (type === GLOBAL_PREFERENCE_TYPE) return;
  if ((NOTIFICATION_TEMPLATE_NAMES as readonly string[]).includes(type)) return;
  throw new ValidationException(
    ErrorCodes.VALIDATION_FAILED,
    `Unknown notification type '${type}' — no such notification exists, so a preference for it could never take effect`,
  );
}

@ApiTags('notifications')
@Auth()
@Controller('notifications/preferences')
export class NotificationPreferencesController {
  constructor(private readonly service: NotificationPreferencesService) {}

  /** List all explicit notification preferences for the current user. */
  @Get()
  @SelfScoped("the caller's own notification preferences")
  @ApiOkResponse({ type: [PreferenceResponseDto] })
  async list(@CurrentUser() user: JwtPayload): Promise<PreferenceResponseDto[]> {
    const prefs = await this.service.listPreferences(user.sub);
    return prefs.map((p) => PreferenceResponseDto.fromDomain(p));
  }

  /**
   * Upsert a preference for a specific event type or '*' wildcard.
   * Use type='*' to globally disable in-app or email notifications.
   */
  @Put(':type')
  @SelfScoped("writes the caller's own preference row (uq_notif_pref_user_type on user.sub)")
  @ApiOkResponse({ type: PreferenceResponseDto })
  @ApiCommonErrors(422)
  async upsert(
    @CurrentUser() user: JwtPayload,
    @Param('type') type: string,
    @Body() dto: UpsertPreferenceDto,
  ): Promise<PreferenceResponseDto> {
    assertKnownPreferenceType(type);
    const pref = await this.service.upsert({
      userId: user.sub,
      type,
      inApp: dto.inApp,
      email: dto.email,
    });
    return PreferenceResponseDto.fromDomain(pref);
  }

  /** Reset a preference to default (re-enable both channels). */
  @Delete(':type')
  @SelfScoped("deletes the caller's own preference row")
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  // Documented here too, not only on the upsert: `assertKnownPreferenceType` guards BOTH routes, so a
  // reset for an event that has no template answers 422 as well. The generated client is built from
  // this spec, so an undeclared status is a response a caller has no type for.
  @ApiCommonErrors(422)
  reset(@CurrentUser() user: JwtPayload, @Param('type') type: string): Promise<void> {
    assertKnownPreferenceType(type);
    return this.service.reset(user.sub, type);
  }
}
