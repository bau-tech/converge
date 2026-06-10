import { Component } from 'react'

export class ErrorBoundary extends Component {
    constructor(props) {
        super(props)
        this.state = { error: null }
    }

    static getDerivedStateFromError(error) {
        return { error }
    }

    componentDidCatch(error, info) {
        console.error('ErrorBoundary caught:', error, info.componentStack)
    }

    render() {
        if (this.state.error) {
            return (
                <div className="flex flex-col items-center justify-center h-full min-h-[200px] text-center p-6">
                    <div className="w-12 h-12 rounded-full bg-red-500/20 flex items-center justify-center mb-4">
                        <span className="text-red-400 text-xl font-bold">!</span>
                    </div>
                    <h3 className="text-lg font-semibold text-red-400 mb-2">Something went wrong</h3>
                    <p className="text-sm text-zinc-500 mb-4 max-w-sm">
                        {this.state.error.message || 'An unexpected error occurred in this panel.'}
                    </p>
                    <button
                        onClick={() => this.setState({ error: null })}
                        className="px-4 py-2 text-sm rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 transition-colors"
                    >
                        Try again
                    </button>
                </div>
            )
        }
        return this.props.children
    }
}
