import { Layer } from 'effect';

import { LiveDynamoDbService } from '@/services/dynamodb.service';
import { ApplicationLoggerService } from '@/services/logger.service';
import { LiveUserRepo } from '@/services/userRepo.service';

const Base = LiveDynamoDbService.pipe(Layer.merge(ApplicationLoggerService));
const UserRepoProvided = LiveUserRepo.pipe(Layer.provide(Base));

export const AppLayer = Base.pipe(Layer.merge(UserRepoProvided));
