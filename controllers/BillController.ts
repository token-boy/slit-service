import { z } from 'zod'

import { Controller, Get, QueryParams } from 'helpers/route.ts'
import { auth } from 'middlewares'
import { cBills } from 'models'

const ListPayloadSchama = z.object({
  type: z.number({ coerce: true }).optional(),
  boardId: z.string().optional(),
  page: z.number({ coerce: true }).nonnegative().default(1),
})
type ListPayload = z.infer<typeof ListPayloadSchama>

@Controller('/v1/bills')
class BillController {
  constructor() {}

  @Get('', auth)
  @QueryParams(ListPayloadSchama)
  async bills({ type, boardId, page }: ListPayload, ctx: Ctx) {
    const filter: { owner: string; type?: number; boardId?: string } = {
      owner: ctx.profile.address,
    }
    if (type !== undefined && type !== -1) {
      filter.type = type
    }
    if (boardId) {
      filter.boardId = boardId
    }

    const bills = await cBills
      .find(filter)
      .sort({ _id: -1 })
      .skip((page - 1) * 20)
      .limit(20)
      .toArray()
    const total = await cBills.countDocuments(filter)

    return { bills, total }
  }
}

export default BillController
