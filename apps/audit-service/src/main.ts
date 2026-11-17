import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { AppModule } from './app.module.js';
import { auditConfig } from './config.js';
import { InternalAppModule } from './internal-app.module.js';

const port = Number.parseInt(process.env.PORT ?? '3004', 10);
const internalPort = Number.parseInt(process.env.INTERNAL_PORT ?? '3104', 10);
const validation = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
  stopAtFirstError: true,
});
const headers = helmet({
  contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
});

const app = await NestFactory.create<NestExpressApplication>(AppModule);
app.getHttpAdapter().getInstance().disable('x-powered-by');
app.useBodyParser('json', { limit: '16kb' });
app.use(cookieParser());
app.use(headers);
app.use(
  (
    _request: unknown,
    response: { setHeader(name: string, value: string): void },
    next: () => void,
  ) => {
    // Respuestas sensibles: la auditoría nunca se guarda en cachés intermedias.
    response.setHeader('Cache-Control', 'no-store');
    next();
  },
);
const allowedOrigins = auditConfig.allowedOrigins();
app.enableCors({
  origin: (origin, callback) => callback(null, !origin || allowedOrigins.has(origin)),
  methods: ['GET', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'X-Request-Id'],
  exposedHeaders: ['X-Request-Id'],
  credentials: true,
  maxAge: 600,
});
app.useGlobalPipes(validation);
app.enableShutdownHooks();

const internalApp = await NestFactory.create<NestExpressApplication>(InternalAppModule);
internalApp.getHttpAdapter().getInstance().disable('x-powered-by');
internalApp.useBodyParser('json', { limit: '256kb' });
internalApp.use(headers);
internalApp.useGlobalPipes(validation);
internalApp.enableShutdownHooks();

await Promise.all([app.listen(port, '0.0.0.0'), internalApp.listen(internalPort, '0.0.0.0')]);
