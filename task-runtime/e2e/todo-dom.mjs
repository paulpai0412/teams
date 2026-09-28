// Browser expressions shared by the real checker and focused regression tests.
// Item identity belongs to the outer row; descendants may repeat that identity.
export const todoRows = `Array.from(document.querySelectorAll('#todo-list [data-todo-id]')).filter(node => !node.parentElement.closest('#todo-list [data-todo-id]'))`;
export const todoCount = `${todoRows}.length`;
// Absence is acceptable only where the caller expects a non-visible empty state.
// Empty-list scenarios separately assert existence and visibility.
export const emptyStateVisible = `Boolean(document.querySelector('[data-testid=empty]')?.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}))`;
