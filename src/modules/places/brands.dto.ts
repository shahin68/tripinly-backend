import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBase64,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { PlaceBrandDto } from './places.dto';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class BrandsQueryDto {
  @ApiProperty({
    minLength: 1,
    maxLength: 60,
    example: 'zar',
    description: 'Start of any word of the brand name, any case',
  })
  @Transform(trim)
  @IsString()
  @Length(1, 60)
  q: string;
}

export class BrandsResponseDto {
  @ApiProperty({
    type: [PlaceBrandDto],
    description: 'At most 20, the brands with the most places first',
  })
  items: PlaceBrandDto[];
}

export class BrandLogoParamsDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  id: string;

  @ApiProperty({ example: '3f2a9c01d4e5b6a7' })
  @Matches(/^[0-9a-f]{16}$/)
  hash: string;
}

export class CreateBrandDto {
  @ApiProperty({ minLength: 1, maxLength: 80, example: 'Zara' })
  @Transform(trim)
  @IsString()
  @Length(1, 80)
  name: string;

  @ApiPropertyOptional({
    example: 'Q147662',
    description:
      'Its Wikidata item, if it has one: the import ties OSM shops with this brand:wikidata to it, and its Wikimedia logo is looked for',
  })
  @IsOptional()
  @Matches(/^Q[0-9]+$/)
  wikidataId?: string;
}

export class UploadBrandLogoDto {
  @ApiProperty({
    description:
      'The logo image (PNG, JPEG, WebP or SVG) in base64, under 70 KB. It is cut to the logo and made into a 96 px square WebP of a few KB; ours always wins over Wikimedia',
  })
  @IsBase64()
  @MaxLength(96_000)
  image: string;
}

export class SetPlaceBrandDto {
  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'The brand, or null to untie the place from its brand',
  })
  @ValidateIf((o: SetPlaceBrandDto) => o.brandId !== null)
  @IsUUID()
  brandId: string | null;
}
