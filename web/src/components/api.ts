export async function api<T>(path: string, data?: unknown): Promise<T> {
  const response = await fetch(path, {
    cache: "no-store",
    ...(data === undefined
      ? {}
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? "Request failed");
  return result;
}
