

export function getPagination(ctx: Ctx) {
  const { searchParams } = ctx.request.url

  let page = parseInt(searchParams.get('page') ?? '1')
  let pageSize = parseInt(searchParams.get('pageSize') ?? '10')

  if (isNaN(page) || page <= 0) {
    page = 1
  }
  if (isNaN(pageSize) || pageSize <= 0 || pageSize > 10) {
    pageSize = 10
  }

  return { limit: pageSize, skip: (page - 1) * pageSize }
}
