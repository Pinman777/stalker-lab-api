import { Controller, Get } from '@nestjs/common';

@Controller()
export class HealthController {
  @Get('api/v1/health')
  health(): { status: string } {
    return { status: 'ok' };
  }
}
