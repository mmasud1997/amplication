import {
  Processor,
  Process,
  OnQueueCompleted,
  OnQueueFailed,
  OnQueuePaused,
  OnQueueActive,
  OnGlobalQueueError
} from '@nestjs/bull';
import { Job } from 'bull';
import { StorageService } from '@codebrew/nestjs-storage';
import * as DataServiceGenerator from 'amplication-data-service-generator';
import { PrismaService } from 'nestjs-prisma';
import winston from 'winston';
import { EntityService } from '..';
import { QUEUE_NAME } from './constants';
import { BuildRequest } from './dto/BuildRequest';
import { EnumBuildStatus } from './dto/EnumBuildStatus';
import { getBuildFilePath } from './storage';
import { createZipFileFromModules } from './zip';
import { AppRoleService } from '../appRole/appRole.service';

@Processor(QUEUE_NAME)
export class BuildConsumer {
  constructor(
    private readonly storageService: StorageService,
    private readonly prisma: PrismaService,
    private readonly entityService: EntityService,
    private readonly appRoleService: AppRoleService
  ) {}

  @OnQueueCompleted()
  async handleCompleted(job: Job<BuildRequest>): Promise<void> {
    await this.updateStatus(job.data.id, EnumBuildStatus.Completed);
  }

  @OnQueueActive()
  async handleActive(job: Job<BuildRequest>): Promise<void> {
    await this.updateStatus(job.data.id, EnumBuildStatus.Active);
  }

  @OnQueueFailed()
  async handleFailed(job: Job<BuildRequest>): Promise<void> {
    await this.updateStatus(job.data.id, EnumBuildStatus.Failed);
  }

  @OnQueuePaused()
  async handlePaused(): Promise<void> {
    await this.prisma.build.updateMany({
      where: {
        // eslint-disable-next-line @typescript-eslint/naming-convention
        NOT: {
          status: {
            in: [EnumBuildStatus.Completed, EnumBuildStatus.Failed]
          }
        }
      },
      data: { status: EnumBuildStatus.Paused }
    });
  }

  @OnGlobalQueueError()
  handleError(error: Error) {
    console.error(error);
  }

  @Process()
  async build(job: Job<BuildRequest>): Promise<void> {
    const { id } = job.data;
    const build = await this.prisma.build.findOne({
      where: { id: id },
      include: {
        blockVersions: {
          select: {
            id: true
          }
        },
        entityVersions: {
          select: {
            id: true
          }
        }
      }
    });
    const entities = await this.getBuildEntities(build);
    const roles = await this.appRoleService.getAppRoles({});
    const logger = winston.createLogger({});
    const modules = await DataServiceGenerator.createDataService(
      entities,
      roles,
      logger
    );
    const filePath = getBuildFilePath(id);
    const disk = this.storageService.getDisk('local');
    const zip = await createZipFileFromModules(modules);
    await disk.put(filePath, zip);
  }

  private async updateStatus(
    id: string,
    status: EnumBuildStatus
  ): Promise<void> {
    await this.prisma.build.update({
      where: { id },
      data: {
        status
      }
    });
  }

  private async getBuildEntities(build: {
    entityVersions: Array<{ id: string }>;
  }): Promise<DataServiceGenerator.FullEntity[]> {
    const entityVersionIds = build.entityVersions.map(
      entityVersion => entityVersion.id
    );
    const entities = await this.entityService.getEntitiesByVersions({
      where: { id: { in: entityVersionIds } },
      include: {
        fields: true,
        entityPermissions: {
          include: {
            permissionRoles: {
              include: {
                appRole: true
              }
            },
            permissionFields: {
              include: {
                field: true,
                permissionFieldRoles: {
                  include: {
                    appRole: true
                  }
                }
              }
            }
          }
        }
      }
    });
    return entities as DataServiceGenerator.FullEntity[];
  }
}
