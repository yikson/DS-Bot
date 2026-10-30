// Work/replies keep their exchange; each continuation owns a separate durable admission.
export function deliveryId(args) {
  if (!args.taskId || !(args.continuationId || args.failureResumes !== undefined || args.retried || args.resumed || args.deferred)) return args.exchangeId
  return JSON.stringify([args.exchangeId, args.continuationId ?? null, args.failureResumes ?? null,
    args.retried === true, args.resumed === true, args.deferred === true])
}
