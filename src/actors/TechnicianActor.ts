import { StatefulActor } from "@telnyx/edge-runtime";

export class TechnicianActor extends StatefulActor {
  async ping(): Promise<{ pong: boolean; count: number }> {
    const count = ((await this.ctx.storage.get<number>("count")) ?? 0) + 1;
    await this.ctx.storage.put("count", count);
    return { pong: true, count };
  }
}
