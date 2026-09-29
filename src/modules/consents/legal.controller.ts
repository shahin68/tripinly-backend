import { Controller, Get, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { I18nLang } from 'nestjs-i18n';
import { Public } from '../../common/auth/auth.decorators';
import { ConsentsService, REQUIRED_DOCUMENTS } from './consents.service';
import { LegalDocumentsDto, LegalDocumentsQueryDto } from './consents.dto';

@ApiTags('legal')
@Controller('legal')
export class LegalController {
  constructor(private readonly consents: ConsentsService) {}

  @Get('documents')
  @Public()
  @ApiOperation({
    summary: 'Current Terms, Privacy Policy and marketing documents',
  })
  @ApiOkResponse({ type: LegalDocumentsDto })
  async documents(
    @Query() query: LegalDocumentsQueryDto,
    @I18nLang() lang: string,
  ): Promise<LegalDocumentsDto> {
    const documents = await this.consents.currentDocuments(
      query.locale ?? lang,
    );
    return {
      items: documents.map((doc) => ({
        documentType: doc.documentType,
        version: doc.version,
        locale: doc.locale,
        url: doc.url,
        publishedAt: doc.publishedAt.toISOString(),
        required: REQUIRED_DOCUMENTS.includes(doc.documentType),
      })),
    };
  }
}
