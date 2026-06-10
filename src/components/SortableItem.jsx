import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { GripVertical } from 'lucide-react'

export function SortableItem({ id, children }) {
    const {
        attributes,
        listeners,
        setNodeRef,
        transform,
        transition,
        isDragging
    } = useSortable({ id })

    const style = {
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.5 : 1,
        position: 'relative'
    }

    return (
        <div ref={setNodeRef} style={style}>
            {/* Drag Handle */}
            <div
                {...attributes}
                {...listeners}
                className="absolute top-3 right-12 z-10 cursor-grab active:cursor-grabbing p-1.5 hover:bg-white/10 rounded transition-colors opacity-0 group-hover:opacity-100"
                title="Drag to reorder"
            >
                <GripVertical className="w-4 h-4 text-zinc-500" />
            </div>
            {children}
        </div>
    )
}
