/**
 * The name of a value from the name of its type, by lowering the first letter (`OrderLine` → `orderLine`): the field a
 * checker suggests (`orderId`) and the parameter the generator writes (`order`) are spelled alike.
 */
export const camel = (s: string): string => s.charAt(0).toLowerCase() + s.slice(1);
