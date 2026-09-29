import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  Length,
  Matches,
} from 'class-validator';

export const DOCUMENT_TYPES = ['terms', 'privacy', 'marketing'] as const;
export type DocumentTypeValue = (typeof DOCUMENT_TYPES)[number];

/** BCP 47-ish: language, optional region/script (e.g. en, de-AT, zh-Hant-TW). */
export const LOCALE_PATTERN = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

export class LegalDocumentsQueryDto {
  @ApiPropertyOptional({
    example: 'de-AT',
    description: 'Defaults to Accept-Language, then en',
  })
  @IsOptional()
  @IsString()
  @Matches(LOCALE_PATTERN)
  locale?: string;
}

export class LegalDocumentDto {
  @ApiProperty({ enum: DOCUMENT_TYPES })
  documentType: DocumentTypeValue;

  @ApiProperty({ example: '2026-09-01' })
  version: string;

  @ApiProperty({ example: 'en' })
  locale: string;

  @ApiProperty({ example: 'https://tripinly.example/legal/terms' })
  url: string;

  @ApiProperty()
  publishedAt: string;

  @ApiProperty({ description: 'Must be accepted before using the app' })
  required: boolean;
}

export class LegalDocumentsDto {
  @ApiProperty({ type: [LegalDocumentDto] })
  items: LegalDocumentDto[];
}

export class RecordConsentDto {
  @ApiProperty({ enum: DOCUMENT_TYPES })
  @IsIn(DOCUMENT_TYPES)
  documentType: DocumentTypeValue;

  @ApiProperty({
    description: 'The version shown to the user; must be current when granting',
  })
  @IsString()
  @Length(1, 50)
  version: string;

  @ApiProperty({ example: 'en', description: 'Locale of the document shown' })
  @IsString()
  @Matches(LOCALE_PATTERN)
  locale: string;

  @ApiProperty({ description: 'true to grant, false to withdraw' })
  @IsBoolean()
  granted: boolean;
}

export class ConsentDto {
  @ApiProperty({ enum: DOCUMENT_TYPES })
  documentType: DocumentTypeValue;

  @ApiProperty()
  version: string;

  @ApiProperty()
  locale: string;

  @ApiProperty({ description: 'Currently granted (latest record is a grant)' })
  granted: boolean;

  @ApiProperty({ type: String, nullable: true })
  grantedAt: string | null;

  @ApiProperty({ type: String, nullable: true })
  withdrawnAt: string | null;
}

export class ConsentsDto {
  @ApiProperty({ type: [ConsentDto] })
  items: ConsentDto[];

  @ApiProperty({
    enum: DOCUMENT_TYPES,
    isArray: true,
    description: 'Required documents still to accept (current versions)',
  })
  missingRequired: DocumentTypeValue[];
}
