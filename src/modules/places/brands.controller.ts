import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
  StreamableFile,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiTags,
} from '@nestjs/swagger';
import { Public } from '../../common/auth/auth.decorators';
import { IdParamDto } from '../../common/dto/id-param.dto';
import { AppException } from '../../common/errors/app.exception';
import { AdminOnly } from '../moderation/admin.guard';
import {
  BrandLogoParamsDto,
  BrandsQueryDto,
  BrandsResponseDto,
  CreateBrandDto,
  SetPlaceBrandDto,
  UploadBrandLogoDto,
} from './brands.dto';
import { BrandsService } from './brands.service';
import { PlaceBrandDto } from './places.dto';

@ApiTags('brands')
@ApiBearerAuth()
@Controller()
export class BrandsController {
  constructor(private readonly brands: BrandsService) {}

  @Get('brands')
  @ApiOperation({
    summary: 'Find a brand for "This is a brand store"',
    description:
      'Brands whose name has a word starting with `q`. People pick from this list; they cannot add brands. Empty while brands are off (BRAND_LOGOS_ENABLED), so the apps offer no "This is a brand store".',
  })
  @ApiOkResponse({ type: BrandsResponseDto })
  async search(@Query() query: BrandsQueryDto): Promise<BrandsResponseDto> {
    return { items: await this.brands.search(query.q) };
  }

  @Get('brands/:id/logo/:hash')
  @Public()
  @Header('Cache-Control', 'public, max-age=31536000, immutable')
  @ApiProduces('image/webp')
  @ApiOperation({
    summary: "A brand's logo (public)",
    description:
      'The path comes from `brand.logoUrl`. A 96 px square WebP that never changes at this path. 404 when logos are off, the brand is hidden or the logo changed.',
  })
  @ApiOkResponse({ description: 'The WebP image' })
  @ApiNotFoundResponse({ description: 'No logo shown here (NOT_FOUND)' })
  async logo(@Param() params: BrandLogoParamsDto): Promise<StreamableFile> {
    const logo = await this.brands.logo(params.id, params.hash);
    if (!logo) throw AppException.notFound();
    return new StreamableFile(logo, { type: 'image/webp' });
  }

  @Post('admin/brands')
  @AdminOnly()
  @ApiOperation({ summary: 'Add a brand (admins)' })
  @ApiCreatedResponse({ type: PlaceBrandDto })
  create(@Body() body: CreateBrandDto): Promise<PlaceBrandDto> {
    return this.brands.create(body);
  }

  @Put('admin/brands/:id/logo')
  @AdminOnly()
  @ApiOperation({
    summary: "Upload a brand's logo (admins)",
    description:
      'Ours wins over the Wikimedia logo and is never replaced by it. An image that cannot be read, or is white on transparency, answers 415 UNSUPPORTED_MEDIA_TYPE.',
  })
  @ApiOkResponse({ type: PlaceBrandDto })
  uploadLogo(
    @Param() params: IdParamDto,
    @Body() body: UploadBrandLogoDto,
  ): Promise<PlaceBrandDto> {
    return this.brands.uploadLogo(params.id, body.image);
  }

  @Delete('admin/brands/:id/logo')
  @AdminOnly()
  @ApiOperation({
    summary: "Remove a brand's logo (admins)",
    description:
      'The brand shows a round pin until the next daily sync finds its Wikimedia logo, if it has one.',
  })
  @ApiOkResponse({ type: PlaceBrandDto })
  removeLogo(@Param() params: IdParamDto): Promise<PlaceBrandDto> {
    return this.brands.removeLogo(params.id);
  }

  @Put('admin/places/:id/brand')
  @AdminOnly()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Tie a place to a brand or untie it (admins)',
    description:
      'For a spot wrongly marked as a brand store. The OSM import ties OSM shops again while their OSM tag says so.',
  })
  @ApiNoContentResponse()
  async setPlaceBrand(
    @Param() params: IdParamDto,
    @Body() body: SetPlaceBrandDto,
  ): Promise<void> {
    await this.brands.setPlaceBrand(params.id, body.brandId);
  }
}
