import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

const port = Number.parseInt(process.env.PORT ?? '3001', 10);
const app = await NestFactory.create(AppModule);
await app.listen(port, '0.0.0.0');
