import type {
  Target,
  TargetWriter,
  TargetWriteResult,
} from '@ai-primitives-hub/core';

export const persistTargetWrite = async <T>(
  writer: TargetWriter,
  target: Target,
  result: TargetWriteResult,
  persist: () => Promise<T>
): Promise<T> => {
  try {
    return await persist();
  } catch (failure) {
    if (writer.rollback !== undefined && result.written.length > 0) {
      try {
        await writer.rollback(target, result.written);
      } catch (rollbackError) {
        throw new AggregateError([failure, rollbackError], 'Tracking failed and target write rollback was incomplete', {
          cause: failure
        });
      }
    }
    throw failure;
  }
};
