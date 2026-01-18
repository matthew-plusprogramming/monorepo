import { Layer } from 'effect';

import { LiveAgentTaskRepo } from '@/services/agentTaskRepo.service';
import { LiveDynamoDbService } from '@/services/dynamodb.service';
import { LiveEventBridgeService } from '@/services/eventBridge.service';
import { LiveGitHubService } from '@/services/github.service';
import { ApplicationLoggerService } from '@/services/logger.service';
import { LiveProjectRepo } from '@/services/projectRepo.service';
import { LiveSpecGroupRepo } from '@/services/specGroupRepo.service';
import { LiveUserRepo } from '@/services/userRepo.service';
import { LiveWebhookService } from '@/services/webhook.service';

const Base = LiveDynamoDbService.pipe(
  Layer.merge(ApplicationLoggerService),
).pipe(Layer.merge(LiveEventBridgeService));

const LiveUserRepoProvided = LiveUserRepo.pipe(Layer.provide(Base));
const LiveSpecGroupRepoProvided = LiveSpecGroupRepo.pipe(Layer.provide(Base));
const LiveAgentTaskRepoProvided = LiveAgentTaskRepo.pipe(Layer.provide(Base));
const LiveProjectRepoProvided = LiveProjectRepo.pipe(Layer.provide(Base));

export const AppLayer = Base.pipe(Layer.merge(LiveUserRepoProvided))
  .pipe(Layer.merge(LiveSpecGroupRepoProvided))
  .pipe(Layer.merge(LiveAgentTaskRepoProvided))
  .pipe(Layer.merge(LiveProjectRepoProvided))
  .pipe(Layer.merge(LiveWebhookService))
  .pipe(Layer.merge(LiveGitHubService));
