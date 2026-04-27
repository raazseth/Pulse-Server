export interface ApiResponse<T = any> {
  type: number;
  success: boolean;
  message: string;
  data: T | null;
}

export function ok<T>(data: T, message = "OK", type = 0): ApiResponse<T> {
  return {
    type,
    success: true,
    message,
    data,
  };
}

export function created<T>(data: T, message = "Created", type = 0): ApiResponse<T> {
  return {
    type,
    success: true,
    message,
    data,
  };
}

