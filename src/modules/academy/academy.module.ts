import { Module } from '@nestjs/common';
import { AcademyController } from './academy.controller';
import { AcademyService } from './academy.service';

/** Академия (нед3): курс kodex из глав книги, квизы, лестница уроков, +20 за урок. */
@Module({
  controllers: [AcademyController],
  providers: [AcademyService],
})
export class AcademyModule {}
