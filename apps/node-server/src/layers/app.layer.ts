import { Layer } from 'effect';

import { LiveDynamoDbService } from '@/services/dynamodb.service';
import { LiveEventBridgeService } from '@/services/eventBridge.service';
import { ApplicationLoggerService } from '@/services/logger.service';
import { LiveUserRepo } from '@/services/userRepo.service';

const Base = LiveDynamoDbService.pipe(
  Layer.merge(ApplicationLoggerService),
).pipe(Layer.merge(LiveEventBridgeService));

const LiveUserRepoProvided = LiveUserRepo.pipe(Layer.provide(Base));

export const AppLayer = Base.pipe(Layer.merge(LiveUserRepoProvided));
