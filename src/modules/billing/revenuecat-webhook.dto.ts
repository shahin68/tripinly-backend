import { ApiProperty } from '@nestjs/swagger';
import { IsObject, IsOptional, IsString } from 'class-validator';
import type { RevenueCatEvent } from './revenuecat-webhook.service';

/** RevenueCat's webhook body. Only `event` is read; its own fields aren't checked here. */
export class RevenueCatWebhookDto {
  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description:
      'The RevenueCat event; `app_user_id`, `aliases`, `transferred_from` and `transferred_to` name the customers to sync',
  })
  @IsObject()
  event!: RevenueCatEvent;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  api_version?: string;
}
