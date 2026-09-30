import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { PrismaService } from '../../common/prisma/prisma.service';
import { NotificationPlanner } from './notification-planner';
import {
  type NotificationJobData,
  NotificationJobs,
  NOTIFICATIONS_QUEUE,
  type PlanInput,
} from './notifications.queue';
import { PushService } from './push.service';

@Processor(NOTIFICATIONS_QUEUE)
export class NotificationsProcessor extends WorkerHost {
  constructor(
    private readonly planner: NotificationPlanner,
    private readonly push: PushService,
    private readonly prisma: PrismaService,
  ) {
    super();
  }

  async process(job: Job): Promise<unknown> {
    switch (job.name) {
      case NotificationJobs.PLAN:
        return this.planner.plan(job.data as PlanInput);
      case NotificationJobs.PUSH: {
        const { notificationId } = job.data as NotificationJobData;
        const sent = await this.push.send(notificationId);
        await this.markPushed(notificationId);
        return { sent };
      }
      case NotificationJobs.FLUSH: {
        const { notificationId } = job.data as NotificationJobData;
        // Closing the group first means later events open a new one. A retry
        // finds it already closed by its own first attempt and still sends.
        const closed = await this.markPushed(notificationId);
        if (!closed && job.attemptsMade === 0) return { sent: 0 };
        return { sent: await this.push.send(notificationId) };
      }
      default:
        throw new Error(`unknown notifications job ${job.name}`);
    }
  }

  private async markPushed(notificationId: string): Promise<boolean> {
    const { count } = await this.prisma.notification.updateMany({
      where: { id: notificationId, pushedAt: null },
      data: { pushedAt: new Date() },
    });
    return count === 1;
  }
}
