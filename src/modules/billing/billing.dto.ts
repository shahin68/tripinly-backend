import { ApiProperty } from '@nestjs/swagger';
import type { ProStatus } from './entitlement.service';

/** My Tripinly Pro, as `POST /me/pro/sync` answers and the `pro.changed` event carries it. */
export class ProStatusDto {
  @ApiProperty({
    type: [String],
    example: ['routes'],
    description:
      'Active premium features, as in GET /me. Show paid UI from this, never from a local flag.',
  })
  entitlements: string[];

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    example: '2027-10-20T08:00:00.000Z',
    description:
      'When the active features end (UTC). Null when they never end (lifetime) or there is no Pro. The apps end Pro locally at this time; a renewal arrives earlier as pro.changed.',
  })
  proExpiresAt: string | null;
}

export function toProStatusDto(status: ProStatus): ProStatusDto {
  return {
    entitlements: status.entitlements,
    proExpiresAt: status.proExpiresAt?.toISOString() ?? null,
  };
}
