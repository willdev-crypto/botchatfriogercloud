const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');

// --- VERIFICAÇÃO DE INSTÂNCIA ÚNICA (SINGLETON) ---
// Isso previne que o bot seja executado múltiplas vezes, o que causa respostas duplicadas.
const lockFilePath = path.join(__dirname, 'bot.lock');
 
const isProcessRunning = (pid) => {
    try {
        // Enviar o sinal 0 para um processo verifica se ele existe sem interrompê-lo.
        // Isso funciona em ambientes POSIX (Linux, macOS) e também no Windows.
        return process.kill(pid, 0);
    } catch (e) {
        // Se o erro for 'ESRCH', o processo não existe. Qualquer outro erro pode ser permissão, etc.
        // Em ambos os casos, consideramos que o processo não está "rodando de forma acessível".
        return false;
    }
};

try {
    // Tenta criar e escrever no arquivo de lock de forma atômica.
    // A flag 'wx' falhará se o arquivo já existir, evitando race conditions.
    fs.writeFileSync(lockFilePath, process.pid.toString(), { flag: 'wx' });
} catch (e) {
    if (e.code === 'EEXIST') {
        // O arquivo já existe. Verificamos se o processo dono do lock ainda está ativo.
        const pid = fs.readFileSync(lockFilePath, 'utf-8');
        if (isProcessRunning(parseInt(pid, 10))) {
            console.error(`❌ ERRO: O bot já está em execução com o PID: ${pid}. Múltiplas instâncias não são permitidas.`);
            console.error('👉 SOLUÇÃO: Se o processo anterior travou, delete o arquivo "bot.lock" e reinicie.');
            process.exit(1);
        } else {
            // O processo antigo não está mais rodando. O bot pode assumir o controle.
            console.warn(`⚠️ AVISO: Arquivo de lock de um processo antigo (PID: ${pid}) encontrado. Assumindo o controle.`);
            fs.writeFileSync(lockFilePath, process.pid.toString()); // Sobrescreve com o novo PID.
        }
    } else {
        // Outro erro inesperado (ex: permissão de escrita).
        console.error('❌ Erro inesperado ao criar o arquivo de lock:', e);
        process.exit(1);
    }
}

// NOTA: A dependência 'puppeteer' não precisa ser importada diretamente
// whatsapp-web.js a utiliza nos bastidores.

const client = new Client({
    authStrategy: new LocalAuth({ clientId: 'frioger-bot-v3' }), // Mudei o ID para evitar conflito de sessão
    webVersionCache: {
        type: 'remote',
        remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html',
    },
    puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
        executablePath: process.env.CHROME_PATH || undefined, // Opcional, ajuda a encontrar o binário
    }
});

// --- CATÁLOGO DE PRODUTOS (INTEGRADO) ---
let pages = [];
try {
    if (fs.existsSync('./catalog.json')) {
        pages = JSON.parse(fs.readFileSync('./catalog.json', 'utf-8'));
    } else {
        console.warn('⚠️ AVISO: Arquivo catalog.json não encontrado. A busca de produtos não funcionará.');
    }
} catch (e) { console.error('❌ Erro ao ler catalog.json:', e.message); }

// --- BANCO DE DADOS SQLITE ---
const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./sessions.db', sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE, (err) => {
    if (err) {
        console.error("Erro ao abrir o banco de dados", err.message);
    } else {
        console.log("Conectado ao banco de dados de sessões.");
        db.run(`CREATE TABLE IF NOT EXISTS sessions (
            user_phone TEXT PRIMARY KEY,
            stage TEXT,
            nome TEXT,
            last_updated INTEGER
        )`, (err) => {
            if (err) {
                console.error("Erro ao criar tabela", err.message);
            }
        });
        // Criar tabela para chamados técnicos
        db.run(`CREATE TABLE IF NOT EXISTS chamados (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_phone TEXT,
            user_name TEXT,
            produto_detectado TEXT,
            relato TEXT,
            status TEXT DEFAULT 'aberto',
            timestamp INTEGER
        )`);
        // Criar tabela para avaliações
        db.run(`CREATE TABLE IF NOT EXISTS avaliacoes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_phone TEXT,
            user_name TEXT,
            nota TEXT,
            timestamp INTEGER
        )`);
    }
});

// --- FUNÇÕES DO BANCO DE DADOS ---
const getUserState = (userPhone) => {
    return new Promise((resolve, reject) => {
        db.get("SELECT * FROM sessions WHERE user_phone = ?", [userPhone], (err, row) => {
            if (err) return reject(err);
            resolve(row);
        });
    });
};

const setUserState = (userPhone, stage, nome) => {
    const now = Date.now();
    return new Promise((resolve, reject) => {
        const query = `
            INSERT INTO sessions (user_phone, stage, nome, last_updated)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(user_phone) DO UPDATE SET
            stage = excluded.stage,
            nome = excluded.nome,
            last_updated = excluded.last_updated;
        `;
        db.run(query, [userPhone, stage, nome, now], function(err) {
            if (err) return reject(err);
            resolve(this);
        });
    });
};

const deleteUserState = (userPhone) => {
    return new Promise((resolve, reject) => {
        db.run("DELETE FROM sessions WHERE user_phone = ?", [userPhone], function(err) {
            if (err) return reject(err);
            resolve(this);
        });
    });
};

const saveTicket = (userPhone, userName, produto, relato) => {
    const now = Date.now();
    return new Promise((resolve, reject) => {
        const query = `INSERT INTO chamados (user_phone, user_name, produto_detectado, relato, timestamp) VALUES (?, ?, ?, ?, ?)`;
        db.run(query, [userPhone, userName, produto, relato, now], function(err) {
            if (err) return reject(err);
            console.log(`💾 Novo chamado técnico salvo no DB. ID: ${this.lastID}`);
            resolve(this);
        });
    });
};

const saveRating = (userPhone, userName, nota) => {
    const now = Date.now();
    return new Promise((resolve, reject) => {
        const query = `INSERT INTO avaliacoes (user_phone, user_name, nota, timestamp) VALUES (?, ?, ?, ?)`;
        db.run(query, [userPhone, userName, nota, now], function(err) {
            if (err) return reject(err);
            console.log(`💾 Nova avaliação salva no DB. ID: ${this.lastID}`);
            resolve(this);
        });
    });
};

// --- CONSTANTES E CONFIGURAÇÕES ---
const PDF_PATH = './assets/Catálogo Oficial Grupo Frioger 2026 - Completo.pdf';
const SPECIALIST_NUMBER = '5511930167985@c.us'; // Substitua pelo número correto

// --- ESTADOS DA CONVERSA ---
const STAGES = {
    CAPTURA_NOME: 'CAPTURA_NOME',
    MENU_PRINCIPAL: 'MENU_PRINCIPAL',
    SUPORTE_TRIAGEM: 'SUPORTE_TRIAGEM',
    AGUARDANDO_HUMANO: 'AGUARDANDO_HUMANO',
    AVALIACAO: 'AVALIACAO'
};

// --- PALAVRAS-CHAVE GLOBAIS ---
const TRIGGERS_SAIR = ['sair', 'encerrar', 'fim', 'cancelar', 'tchau', 'obrigado', '0'];
const TRIGGERS_HUMANO = ['consultor', 'vendedor', 'especialista', 'humano', 'atendente', 'falar com', '6'];
const TRIGGERS_CATALOGO = ['catalogo', 'catálogo', 'pdf', 'tabela', 'lista', 'preço', 'preco', '1'];

// --- FUNÇÕES AUXILIARES ---
const delay = (ms) => new Promise(res => setTimeout(res, ms));

const normalizeText = (text = '') => {
    return text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
};

const findProductInCatalog = (query) => {
    if (!query || query.length < 3) return null; // Evita buscas por strings muito curtas
    const normalizedQuery = normalizeText(query);
    for (const page of pages) {
        if (page.items) {
            for (const item of page.items) {
                const itemName = item.n ? normalizeText(item.n) : '';
                const itemDesc = item.d ? normalizeText(item.d) : '';
                const itemSpecs = item.techSpecs ? item.techSpecs.some(spec => normalizeText(spec).includes(normalizedQuery)) : false;

                if (itemName.includes(normalizedQuery) || itemDesc.includes(normalizedQuery) || itemSpecs) {
                    return { ...item, category: page.title, sub: page.sub };
                }
            }
        }
    }
    return null;
};

// --- FUNÇÃO PARA ENVIAR O MENU PRINCIPAL (TEXTO) ---
const sendMainMenu = async (userPhone, userName) => {
    const menuText = `✨ É um prazer ter você aqui, *${userName}*!

Como posso te ajudar hoje? 🤝
_Digite o NÚMERO de uma opção ou o NOME de um produto._

━━━━━━━━━━━━━━━━━━

🛒 *ÁREA COMERCIAL*

1️⃣  Baixar Catálogo em PDF (Completo 2026)
2️⃣  Ver Produtos por Categoria 
3️⃣  Cotação de Peças Originais

━━━━━━━━━━━━━━━━━━

🛠️ *SUPORTE & SERVIÇOS*

4️⃣  Solicitar Instalação ou Manutenção
5️⃣  Dúvidas Técnicas / Defeitos

━━━━━━━━━━━━━━━━━━

👤 *ATENDIMENTO*

6️⃣  Falar com Especialista
0️⃣  Encerrar Conversa`;

    await client.sendMessage(userPhone, menuText);
    await setUserState(userPhone, STAGES.MENU_PRINCIPAL, userName);
};


// --- INICIALIZAÇÃO DO CLIENTE ---
client.on('qr', (qr) => {
    qrcode.generate(qr, { small: true });
    console.log('⚡ QR Code gerado! Aguardando conexão...');
});

client.on('ready', () => {
    console.log('❄️ Bot Grupo Frioger: ONLINE e Pronto para Excelência.');
});


// --- LÓGICA PRINCIPAL DE MENSAGENS ---
client.on('message', async msg => {
    try {
        // Filtros de segurança e anti-loop
        if (msg.fromMe || !msg.from || msg.from.includes('@g.us') || msg.from === 'status@broadcast' || msg.type === 'revoked' || msg.type === 'e2e_notification' || msg.type === 'call_log') {
            return;
        }

        const userPhone = msg.from;
        const texto = (msg.body || '').trim();
        if (texto === '') return; // Ignora mensagens vazias
        const normalizedInput = normalizeText(texto);
        const chat = await msg.getChat();

        let userState = await getUserState(userPhone);

        // --- CAPTURA DE NOME PARA NOVAS SESSÕES ---
        if (!userState) {
            console.log(`✨ Iniciando nova sessão para: ${userPhone}`);
            await chat.sendStateTyping();
            await delay(1500);
            await client.sendMessage(userPhone, `👋 Olá! Seja muito bem-vindo(a) ao *Grupo Frioger*. ❄️\n_Excelência em Climatização e Refrigeração._\n\n🤖 Sou seu assistente virtual inteligente.\n\nPara iniciarmos, por favor, digite seu *NOME* abaixo: 👇`);
            await setUserState(userPhone, STAGES.CAPTURA_NOME, ''); // Define o estágio, nome vazio
            return;
        }

        // --- GESTÃO DE COMANDOS GLOBAIS (SAIR, VOLTAR, HUMANO) ---
        // O comando "sair" funciona a qualquer momento
        if (TRIGGERS_SAIR.some(trigger => normalizedInput.includes(trigger))) {
            if (userState.nome) { // Se o usuário já se identificou, pede avaliação
                await setUserState(userPhone, STAGES.AVALIACAO, userState.nome);
                await client.sendMessage(userPhone, `*Foi um prazer atender você, ${userState.nome}!*

Para nos ajudar a melhorar, que nota você dá para este atendimento?
(De 1 a 5)`);
            } else { // Se não, apenas encerra
                await client.sendMessage(userPhone, 'Atendimento encerrado. Obrigado!');
                await deleteUserState(userPhone);
            }
            return;
        }

        // Outros comandos globais só funcionam se o usuário já tiver um nome
        if (userState.nome) {
            const querHumano = TRIGGERS_HUMANO.some(trigger => {
                // Exige correspondência exata para gatilhos de um único caractere (como '6')
                if (trigger.length === 1) return normalizedInput === trigger;
                // Usa 'includes' para gatilhos de texto para mais flexibilidade
                return normalizedInput.includes(trigger);
            });
            if (querHumano) {
                await client.sendMessage(userPhone, `🔔 *Entendido.* Estou transferindo você para a fila prioritária de atendimento humano.\n\n🕒 *Aguarde um instante, logo alguém irá te responder!*`);
                await setUserState(userPhone, STAGES.AGUARDANDO_HUMANO, userState.nome);
                const linkWpp = `https://wa.me/${userPhone.split('@')[0]}`;
                await client.sendMessage(SPECIALIST_NUMBER, `🚨 *ALERTA DE ATENDIMENTO* 🚨\n\n👤 *Cliente:* ${userState.nome}\n📂 *Solicitação:* Falar com Especialista (Menu)\n📱 *Link direto:* ${linkWpp}\n\n_O cliente está aguardando na fila._`);
                return;
            }

            if (['menu', 'voltar', 'inicio', 'oi', 'ola'].some(trigger => normalizedInput === trigger)) {
                await sendMainMenu(userPhone, userState.nome);
                return;
            }
        }


        // ============================================================
        // 🚦 MÁQUINA DE ESTADOS PRINCIPAL
        // ============================================================
        switch (userState.stage) {
            case STAGES.CAPTURA_NOME:
                const nomeCapturado = texto.split(' ')[0];
                // Validação básica para evitar nomes muito curtos ou inválidos
                if (nomeCapturado.length < 2) {
                    await client.sendMessage(userPhone, '⚠️ Por favor, digite um nome válido para continuarmos.');
                    return;
                }
                const nomeFormatado = nomeCapturado.charAt(0).toUpperCase() + nomeCapturado.slice(1).toLowerCase();
                await chat.sendStateTyping();
                await delay(1000);
                await sendMainMenu(userPhone, nomeFormatado); // Esta função já atualiza o estado
                break;

            case STAGES.MENU_PRINCIPAL:
                switch (normalizedInput) {
                    case '1': // Baixar Catálogo
                        await client.sendMessage(userPhone, `📄 *Perfeito!* Estou enviando o catálogo para você...\n\n⏳ _Só um instante..._`);
                        try {
                            if (fs.existsSync(PDF_PATH)) {
                                const media = MessageMedia.fromFilePath(PDF_PATH);
                                await client.sendMessage(userPhone, media, { caption: `✅ *Aqui está, ${userState.nome}!*\n\n📘 *Catálogo Oficial 2026 - Grupo Frioger*\n\n👀 Dê uma olhada nas novidades. Se gostar de algo, é só me dizer o nome do produto aqui no chat!` });
                            } else {
                                await client.sendMessage(userPhone, '⚠️ Ocorreu um erro ao carregar o arquivo. Notifiquei o suporte.');
                            }
                        } catch (e) { console.error('Erro ao enviar PDF:', e); }
                        await delay(2000);
                        await sendMainMenu(userPhone, userState.nome); // Volta ao menu principal
                        break;

                    case '2': // Ver Produtos por Categoria
                        await client.sendMessage(userPhone, `📁 *Selecione a Categoria Desejada:*\n\n━━━━━━━━━━━━━━━━━━\n\n❄️  *Climatização*\n_(Splits, Cassette, Piso Teto)_\n\n🧊  *Refrigeração*\n_(Geladeiras, Freezers, Cervejeiras)_\n\n🏠  *Eletrodomésticos*\n_(Lava e Seca, Air Fryers, Fornos)_\n\n━━━━━━━━━━━━━━━━━━\n\n✍️  _*Digite o nome do produto que você procura:*_`);
                        // Não mudamos o estado. A próxima mensagem será uma busca de produto,
                        // que será tratada pelo 'default' deste mesmo switch.
                        break;

                    case '3': // Peças
                        await client.sendMessage(userPhone, `⚙️  *Peças Genuínas Midea & Carrier*\n\nPara agilizar, precisamos do modelo exato.\n\n📸  *Por favor, envie uma FOTO DA ETIQUETA do aparelho ou digite o código da peça.*\n\n_Um técnico verificará nosso estoque imediatamente._`);
                        await setUserState(userPhone, STAGES.AGUARDANDO_HUMANO, userState.nome);
                        break;

                    case '4': // Instalação/Manutenção
                    case '5': // Suporte
                        await client.sendMessage(userPhone, `🛠️  *Suporte Técnico Especializado*\n\n📝  *Descreva brevemente qual é o equipamento e o que está acontecendo:*\n\n_Exemplo: "Ar condicionado Midea pingando" ou "Geladeira não gela"._`);
                        await setUserState(userPhone, STAGES.SUPORTE_TRIAGEM, userState.nome);
                        break;

                    default: // Fallback para busca de produto
                        const produtoEncontrado = findProductInCatalog(texto);
                        if (produtoEncontrado) {
                            await chat.sendStateTyping();
                            await delay(1000);
                            let respostaProduto = `❄️ *Encontrei este produto para você:*\n\n`;
                            respostaProduto += `📦 *${produtoEncontrado.n}*\n`;
                            respostaProduto += `📝 _${produtoEncontrado.d}_\n\n`;
                            if (produtoEncontrado.techSpecs) {
                                respostaProduto += `⚙️ *Especificações:*\n`;
                                produtoEncontrado.techSpecs.forEach(spec => {
                                    respostaProduto += `• ${spec}\n`;
                                });
                            }
                            respostaProduto += `\n📂 *Categoria:* ${produtoEncontrado.category} - ${produtoEncontrado.sub}`;
                            respostaProduto += `\n\n💬 *Deseja falar com um vendedor sobre este item?* Digite 6 para falar com um especialista.`;
                            await client.sendMessage(userPhone, respostaProduto);
                        } else {
                            await client.sendMessage(userPhone, '❌ Opção não reconhecida. Por favor, digite um número do menu ou o nome de um produto.');
                        }
                        break;
                }
                break;

            case STAGES.SUPORTE_TRIAGEM:
                const produtoDetectado = findProductInCatalog(texto);
                const nomeProduto = produtoDetectado ? produtoDetectado.n : "Equipamento não especificado";
                await chat.sendStateTyping();
                await delay(1500);
                const linkWppSuporte = `https://wa.me/${userPhone.split('@')[0]}`;
                await client.sendMessage(userPhone, `✅ *Recebido, ${userState.nome}.*\n\n📝 Sua solicitação foi registrada.\n\n👨‍🔧 Nossa equipe técnica analisará e retornará o contato neste mesmo chat em breve.\n\n_Enquanto um de nossos especialistas analisa sua solicitação, nosso atendimento automático será pausado. Para retornar ao menu principal a qualquer momento, basta digitar *#menu*._`);
                await saveTicket(userPhone, userState.nome, nomeProduto, texto); // Salva o chamado no DB
                await client.sendMessage(SPECIALIST_NUMBER, `🛠️ *NOVO CHAMADO TÉCNICO* 🛠️\n\n👤 *Cliente:* ${userState.nome}\n❄️ *Possível Produto:* ${nomeProduto}\n📝 *Relato:* "${texto}"\n📱 *Link:* ${linkWppSuporte}`);
                await setUserState(userPhone, 'MODO_SILENCIOSO', userState.nome); // Pausa o bot para este usuário
                break;

            case STAGES.AGUARDANDO_HUMANO:
                // Neste estado, qualquer mensagem do usuário é encaminhada para o especialista.
                // O bot não responde, apenas repassa, até que o usuário use um comando global (sair, etc).
                const linkWppHumano = `https://wa.me/${userPhone.split('@')[0]}`;
                let msgEspecialista = `💬 *Nova mensagem do cliente* (${userState.nome}):\n\n`;
                if (msg.hasMedia) {
                    msgEspecialista += "📷 _O cliente enviou uma mídia (foto/vídeo/arquivo)._";
                } else {
                    msgEspecialista += `_"${texto}"_`;
                }
                msgEspecialista += `\n\n🔗 *Responder:* ${linkWppHumano}`;
                await client.sendMessage(SPECIALIST_NUMBER, msgEspecialista);
                // Não mudamos o estado para MODO_SILENCIOSO para que o usuário possa continuar enviando mensagens.
                break;

            case STAGES.AVALIACAO:
                await saveRating(userPhone, userState.nome, texto); // Salva a avaliação no DB
                let respostaFinal = (normalizedInput.includes('5') || normalizedInput.includes('excelente'))
                    ? '🤩 Uau! Ficamos muito felizes em saber. Obrigado pela preferência!'
                    : '🤝 Obrigado pelo seu feedback! O Grupo Frioger agradece o contato.';
                await client.sendMessage(userPhone, respostaFinal + '\n\n_Atendimento Encerrado._');
                await deleteUserState(userPhone);
                break;

            case 'MODO_SILENCIOSO':
                // O bot não responde nada, para não interferir em uma conversa humana.
                // Apenas verifica se o usuário quer reativar o menu.
                if (['#menu', '#iniciar', '#voltar', 'menu principal'].includes(normalizedInput)) {
                    console.log(`♻️  Reativando bot para ${userPhone} a pedido do usuário.`);
                    await sendMainMenu(userPhone, userState.nome);
                }
                break;

            default:
                console.log(`Estado desconhecido: ${userState.stage}. Reiniciando para ${userPhone}`);
                await sendMainMenu(userPhone, userState.nome || 'visitante');
                break;
        }

    } catch (err) {
        console.error('❌ Erro fatal no processamento da mensagem:', err);
    }
});


// --- INICIALIZAÇÃO E TRATAMENTO DE ERROS ---
client.initialize().catch(err => {
    if (err.message && err.message.includes('browser is already running')) {
        console.error('❌ ERRO CRÍTICO: O navegador (Chrome) ficou travado.');
        console.error('👉 SOLUÇÃO: Use o Gerenciador de Tarefas para fechar todos os processos "chrome.exe".');
    } else {
        console.error('❌ Erro fatal na inicialização:', err);
    }
});

process.on('uncaughtException', (err) => {
    console.error('⚠️ Erro Crítico (uncaughtException):', err);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('⚠️ Promessa Rejeitada (unhandledRejection):', reason);
});

const gracefulShutdown = async (signal) => {
    console.log(`\n🔴 Recebido sinal de encerramento (${signal}). Finalizando graciosamente...`);
    try {
        await client.destroy();
        console.log('Cliente do WhatsApp desconectado.');
    } catch (e) {
        console.error('Erro ao destruir o cliente:', e);
    } finally {
        db.close((err) => {
            if (err) {
                console.error('Erro ao fechar o banco de dados:', err.message);
            } else {
                console.log('Conexão com o banco de dados fechada.');
            }
            // Remove o lock file apenas se este processo for o dono
            try {
                const pidInLock = fs.readFileSync(lockFilePath, 'utf-8');
                if (pidInLock === process.pid.toString()) {
                    fs.unlinkSync(lockFilePath);
                    console.log('Arquivo de lock removido.');
                }
            } catch (e) { /* Ignora erros (arquivo pode não existir, etc.) */ }
            console.log('Processo encerrado.');
            process.exit(0);
        });
    }
};

process.on('SIGINT', () => gracefulShutdown('SIGINT')); // Captura Ctrl+C
process.on('SIGTERM', () => gracefulShutdown('SIGTERM')); // Captura sinais de término (ex: do Docker, Koyeb)