import { Boom } from '@hapi/boom'
import NodeCache from 'node-cache'
import makeWASocket, {
    DisconnectReason,
    WACallEvent,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    useMultiFileAuthState,
    proto,
    delay
} from '@whiskeysockets/baileys'
import P from 'pino'
import EventEmitter from 'events'
import TypedEventEmitter from 'typed-emitter'
import chalk from 'chalk'
import { readdir, unlink, rmdir } from 'fs-extra'
import { join } from 'path'
import { Anime } from '@shineiichijo/marika'
import { BaseCommand, Database, Parser, Utils } from '.'
import { IAnimeStore } from '../types'

export class Client extends (EventEmitter as new () => TypedEventEmitter<Events>) {
    constructor(
        public config: {
            prefix: string
            owner: string[]
            session_dir: string
        } = {
            prefix: '!',
            owner: [],
            session_dir: 'auth'
        }
    ) {
        super()
    }
    public connect = async () => {
        const { state, saveCreds } = await useMultiFileAuthState(
            this.config.session_dir
        )
        const { version } = await fetchLatestBaileysVersion()
        const sock = makeWASocket({
            printQRInTerminal: true,
            version,
            logger: this.logger,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, this.logger)
            },
            msgRetryCounterCache: this.msgRetryCounterCache,
            generateHighQualityLinkPreview: true,
            getMessage: async () => {
                return {
                    conversation: ''
                }
            },
            qrTimeout: 60 * 1000
        })
        sock.ev.process(async (events) => {
            if (events['connection.update']) {
                const update = events['connection.update']
                const { connection, lastDisconnect } = update
                if (update.qr)
                    console.log(
                        `${chalk.blueBright('[QR]')} - Scan the QR code from the terminal to connect your WhatsApp device.`
                    )
                if (connection === 'connecting')
                    console.log(
                        `${chalk.greenBright('[CONNECTION]')} - Connecting to WhatsApp...`
                    )
                if (connection === 'open') {
                    console.log(
                        `${chalk.greenBright('[CONNECTION]')} - Connected to the WhatsApp.`
                    )
                    this.emit('open')
                }
                if (connection === 'close') {
                    if (
                        (lastDisconnect?.error as Boom)?.output?.statusCode !==
                        DisconnectReason.loggedOut
                    )
                        this.connect()
                    else {
                        console.log(
                            `${chalk.greenBright('[CONNECTION]')} - You've been logged out of this session.`
                        )
                        await delay(3000)
                        await this.deleteSession()
                        await this.connect()
                    }
                }
            }
            if (events['creds.update']) await saveCreds()
            if (events.call) this.emit('new-call', events.call[0])
            if (events['messages.upsert'])
                this.emit('new-message', events['messages.upsert'].messages[0])
        })
        this.sock = sock
        return sock
    }

    public init = async (): Promise<void> => {
        const data = this.store.get('today')
        if (!data || !data.length) return void null
        for (const anime of data) {
            const localAiringTime = this.utils.getLocalAiringTime(
                anime.broadcast_data.time
                    .split(':')
                    .map((x) => (x.length < 2 ? `0${x}` : x))
                    .join(':'),
                anime.broadcast_data.timezone
            )
            const ms = this.utils.getTimeoutMs(localAiringTime)
            if (ms < 0) continue
            const { getAnimeSearch } = new Anime()
            const { data } = await getAnimeSearch({ q: anime.title })
            const animeData = data[0]
            const getImage = () => {
                if (animeData.images.jpg.large_image_url)
                    return animeData.images.jpg.large_image_url
                if (animeData.images.jpg.image_url)
                    return animeData.images.jpg.image_url
                return animeData.images.jpg.small_image_url || ''
            }
            if (!this.scheduled.includes(anime.title)) {
                this.scheduled.push(anime.title)
                const id = setTimeout(async () => {
                    const mapData = this.store.get('today')
                    this.timer.delete(anime.title)
                    if (!mapData || !mapData.length) return void null
                    const index = mapData.findIndex(
                        (x) => x.title === anime.title
                    )
                    if (index < 0) return void null
                    for (const id of mapData[index].registered) {
                        if (!mapData[index].delayed) {
                            const image = await this.utils.getBuffer(getImage())
                            await this.sock.sendMessage(id, {
                                image,
                                jpegThumbnail: image.toString('base64'),
                                caption: `Episode ${anime.ep} of the anime ${animeData.title_english || animeData.title} has just been aired. ${anime.links.length ? `\n\n*External Links:*\n${anime.links.join('\n')}\n\n*Note:* It might take some time for this episode to appear on one of the external links.` : ''}`,
                                contextInfo: {
                                    externalAdReply: {
                                        title: 'MyAnimeList',
                                        thumbnail: await this.utils.getBuffer(
                                            'https://upload.wikimedia.org/wikipedia/commons/7/7a/MyAnimeList_Logo.png'
                                        ),
                                        mediaType: 1,
                                        body:
                                            animeData.title_english ||
                                            animeData.title,
                                        sourceUrl: animeData.url
                                    }
                                }
                            })
                        }
                    }
                }, ms)
                this.timer.set(anime.title, id)
            }
        }
    }

    private deleteSession = async (): Promise<void> => {
        console.log(
            `${chalk.yellowBright('[SESSION]')} - Deleting session ${this.config.session_dir}.`
        )
        const path = [__dirname, '..', '..', this.config.session_dir]
        const files = await readdir(join(...path))
        for (const file of files) await unlink(join(...path, file))
        await rmdir(join(...path))
        console.log(
            `${chalk.yellowBright('[SESSION]')} - Session deleted successfully.`
        )
    }

    public msgRetryCounterCache = new NodeCache()
    public logger = P({ level: 'silent' }).child({}) as any
    public sock!: ReturnType<typeof makeWASocket>
    public commands = new Map<string, BaseCommand>()
    public cooldown = new Map<string, number>()
    public store = new Map<'today', IAnimeStore[]>()
    public timer = new Map<string, NodeJS.Timeout>()
    public db = new Database()
    public utils = new Utils()
    public parser = new Parser()
    public scheduled: string[] = []
}

type Events = {
    'new-call': (call: WACallEvent) => void
    'new-message': (m: proto.IWebMessageInfo) => void
    open: () => void
}